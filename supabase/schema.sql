-- =====================================================================
-- ShapeLab · banco de dados e autenticação (Supabase / Postgres)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.
-- Pode rodar de novo sem perder dados (usa "if not exists" / "or replace").
--
-- Modelo de acesso: o app NUNCA lê as tabelas diretamente. Toda leitura e
-- escrita passa pelas funções abaixo (RPC), que validam o token de sessão.
-- As tabelas ficam com RLS ligado e sem políticas, então a chave pública
-- (anon) não consegue ler nem escrever nada fora dessas funções.
--
-- Fluxo de login (decisão de produto, risco aceito pelo dono do app):
--   * Cadastro: nome + data de nascimento + PIN de 4 dígitos.
--   * Login: nome + data. Se existir UMA conta com esse par, entra direto.
--   * Se existirem DUAS ou mais, o app pede o PIN para desempatar.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- tabelas ----------
create table if not exists app_users (
  id          uuid primary key default extensions.gen_random_uuid(),
  display_name text not null,
  name_key    text not null,
  birth       date not null,
  pin_hash    text not null,
  created_at  timestamptz not null default now()
);
create index if not exists app_users_lookup on app_users (name_key, birth);

create table if not exists app_tokens (
  token_hash text primary key,
  user_id    uuid not null references app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists app_tokens_user on app_tokens (user_id);

create table if not exists app_state (
  user_id    uuid primary key references app_users(id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists app_sessions (
  user_id uuid not null references app_users(id) on delete cascade,
  id      text not null,
  date    timestamptz,
  data    jsonb not null,
  primary key (user_id, id)
);

create table if not exists app_photos (
  user_id    uuid not null references app_users(id) on delete cascade,
  id         text not null,
  session_id text,
  date       timestamptz,
  data       jsonb not null,
  primary key (user_id, id)
);

create table if not exists app_pin_failures (
  name_key text not null,
  birth    date not null,
  at       timestamptz not null default now()
);
create index if not exists app_pin_failures_lookup on app_pin_failures (name_key, birth, at);

create table if not exists app_ai_calls (
  user_id uuid not null references app_users(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists app_ai_calls_lookup on app_ai_calls (user_id, at);

alter table app_users        enable row level security;
alter table app_tokens       enable row level security;
alter table app_state        enable row level security;
alter table app_sessions     enable row level security;
alter table app_photos       enable row level security;
alter table app_pin_failures enable row level security;
alter table app_ai_calls     enable row level security;

-- ---------- utilitários ----------
-- "Lucas", " lúcas ", "LUCAS" viram a mesma chave.
create or replace function sl_name_key(p text) returns text
language sql immutable as $$
  select regexp_replace(
           translate(lower(trim(coalesce(p, ''))),
                     'áàâãäéèêëíìîïóòôõöúùûüçñ',
                     'aaaaaeeeeiiiiooooouuuucn'),
           '\s+', ' ', 'g')
$$;

create or replace function sl_issue_token(p_user uuid, p_remember boolean) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text;
begin
  t := encode(gen_random_bytes(32), 'hex');
  insert into app_tokens (token_hash, user_id, expires_at)
  values (encode(digest(t, 'sha256'), 'hex'), p_user,
          now() + case when coalesce(p_remember, false) then interval '365 days' else interval '12 hours' end);
  delete from app_tokens where user_id = p_user and expires_at < now();
  return t;
end $$;

-- Devolve o usuário do token ou erro "not_authenticated".
create or replace function sl_uid(p_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid;
begin
  select user_id into u from app_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > now();
  if u is null then raise exception 'not_authenticated'; end if;
  return u;
end $$;

-- ---------- cadastro ----------
create or replace function signup(p_name text, p_birth date, p_pin text, p_remember boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k text := sl_name_key(p_name); u uuid; nm text := left(trim(coalesce(p_name, '')), 40);
begin
  if length(nm) < 2 then return jsonb_build_object('status', 'invalid_name'); end if;
  if p_birth is null or p_birth < date '1900-01-01' or p_birth > current_date then return jsonb_build_object('status', 'invalid_birth'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('status', 'invalid_pin_format'); end if;
  -- Mesmo nome + mesma data + mesmo PIN tornaria impossível saber quem é quem.
  if exists (select 1 from app_users where name_key = k and birth = p_birth and pin_hash = crypt(p_pin, pin_hash)) then
    return jsonb_build_object('status', 'pin_taken');
  end if;
  insert into app_users (display_name, name_key, birth, pin_hash)
  values (nm, k, p_birth, crypt(p_pin, gen_salt('bf', 8))) returning id into u;
  insert into app_state (user_id, state) values (u, jsonb_build_object('profile', jsonb_build_object('name', nm)));
  return jsonb_build_object('status', 'ok', 'token', sl_issue_token(u, p_remember), 'name', nm, 'user_id', u);
end $$;

-- ---------- login ----------
-- Sem PIN:  1 conta -> entra | 0 -> not_found | 2+ -> pin_required
-- Com PIN:  valida contra as contas com esse nome + data
create or replace function login(p_name text, p_birth date, p_pin text default null, p_remember boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k text := sl_name_key(p_name); n int; u uuid; nm text;
begin
  select count(*) into n from app_users where name_key = k and birth = p_birth;
  if n = 0 then return jsonb_build_object('status', 'not_found'); end if;

  if p_pin is null or p_pin = '' then
    if n = 1 then
      select id, display_name into u, nm from app_users where name_key = k and birth = p_birth;
      return jsonb_build_object('status', 'ok', 'token', sl_issue_token(u, p_remember), 'name', nm, 'user_id', u);
    end if;
    return jsonb_build_object('status', 'pin_required');
  end if;

  -- Proteção contra tentativa e erro: 5 PINs errados em 15 min bloqueiam esse nome + data.
  if (select count(*) from app_pin_failures where name_key = k and birth = p_birth and at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('status', 'locked');
  end if;
  select id, display_name into u, nm from app_users
   where name_key = k and birth = p_birth and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if u is null then
    insert into app_pin_failures (name_key, birth) values (k, p_birth);
    delete from app_pin_failures where at < now() - interval '1 day';
    return jsonb_build_object('status', 'invalid_pin');
  end if;
  return jsonb_build_object('status', 'ok', 'token', sl_issue_token(u, p_remember), 'name', nm, 'user_id', u);
end $$;

create or replace function logout(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from app_tokens where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function me(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token); r record;
begin
  select id, display_name into r from app_users where id = u;
  return jsonb_build_object('user_id', r.id, 'name', r.display_name);
end $$;

create or replace function delete_account(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin delete from app_users where id = sl_uid(p_token); end $$;

-- ---------- dados do app ----------
create or replace function get_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token); r record;
begin
  select state, updated_at into r from app_state where user_id = u;
  if r is null then return jsonb_build_object('exists', false); end if;
  return jsonb_build_object('exists', true, 'state', r.state, 'updated_at', r.updated_at);
end $$;

create or replace function save_state(p_token text, p_state jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  if octet_length(p_state::text) > 1000000 then raise exception 'state_too_large'; end if;
  insert into app_state (user_id, state, updated_at) values (u, p_state, now())
  on conflict (user_id) do update set state = excluded.state, updated_at = now();
end $$;

create or replace function list_sessions(p_token text, p_limit int default 400) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  return coalesce((select jsonb_agg(data order by date desc nulls last)
                     from (select data, date from app_sessions where user_id = u order by date desc nulls last limit least(coalesce(p_limit, 400), 1000)) s), '[]'::jsonb);
end $$;

create or replace function save_session(p_token text, p_id text, p_data jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  if octet_length(p_data::text) > 200000 then raise exception 'session_too_large'; end if;
  insert into app_sessions (user_id, id, date, data) values (u, p_id, (p_data->>'date')::timestamptz, p_data)
  on conflict (user_id, id) do update set data = excluded.data, date = excluded.date;
end $$;

create or replace function delete_session(p_token text, p_id text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin delete from app_sessions where user_id = sl_uid(p_token) and id = p_id; end $$;

create or replace function list_photos(p_token text, p_limit int default 60) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  return coalesce((select jsonb_agg(data order by date desc nulls last)
                     from (select data, date from app_photos where user_id = u order by date desc nulls last limit least(coalesce(p_limit, 60), 200)) s), '[]'::jsonb);
end $$;

create or replace function save_photo(p_token text, p_id text, p_data jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  if octet_length(p_data::text) > 600000 then raise exception 'photo_too_large'; end if;
  insert into app_photos (user_id, id, session_id, date, data)
  values (u, p_id, p_data->>'sessionId', (p_data->>'date')::timestamptz, p_data)
  on conflict (user_id, id) do update set data = excluded.data, date = excluded.date, session_id = excluded.session_id;
end $$;

create or replace function delete_photo(p_token text, p_id text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin delete from app_photos where user_id = sl_uid(p_token) and id = p_id; end $$;

-- ---------- uso da IA (chamado só pela Edge Function, com a service role) ----------
create or replace function ai_check(p_token text, p_max_per_hour int default 60) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := sl_uid(p_token);
begin
  if (select count(*) from app_ai_calls where user_id = u and at > now() - interval '1 hour') >= p_max_per_hour then
    raise exception 'rate_limited';
  end if;
  insert into app_ai_calls (user_id) values (u);
  delete from app_ai_calls where at < now() - interval '2 days';
  return u;
end $$;

-- ---------- permissões ----------
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public;
grant execute on function signup(text, date, text, boolean), login(text, date, text, boolean), logout(text), me(text), delete_account(text),
  get_state(text), save_state(text, jsonb), list_sessions(text, int), save_session(text, text, jsonb), delete_session(text, text),
  list_photos(text, int), save_photo(text, text, jsonb), delete_photo(text, text)
  to anon, authenticated;
grant execute on function ai_check(text, int) to service_role;
