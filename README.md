# ShapeLab

App de treino que roda no navegador do celular e pode ser instalado na tela inicial.
Fica hospedado no **Cloudflare** (grátis): o mesmo lugar serve o app e guarda as contas e os treinos no banco D1.
Toda mudança enviada para este repositório no GitHub é publicada sozinha.

## O que tem aqui

| Pasta / arquivo | Para que serve |
|---|---|
| `public/` | O app (página, telas de login, fotos dos exercícios, ícones, leitor de PDF) |
| `src/worker.js` | O servidor: cadastro, login, fichas, treinos e fotos |
| `wrangler.toml` | Configuração do Cloudflare (nome do app e banco) |

## Publicar (uma vez só)

1. Entre em **dash.cloudflare.com** e clique em **Criar aplicativo** (Workers e Pages → Criar).
2. Escolha **Importar um repositório** (Import a repository), conecte o GitHub e selecione `shapelab`.
3. Não mude nada nas configurações e clique em **Implantar** (Deploy).
4. Em 1 ou 2 minutos aparece o link do app, algo como `https://shapelab.SEU-USUARIO.workers.dev`.

O banco é criado sozinho na primeira publicação, e as tabelas na primeira vez que alguém usa o app.

Depois disso, cada mudança no GitHub atualiza o mesmo link em cerca de 1 minuto. Os dados das contas não se perdem.

## Instalar no celular

- iPhone (Safari): Compartilhar → **Adicionar à Tela de Início**.
- Android (Chrome): menu ⋮ → **Instalar app**.

## Como funciona o login

- **Criar conta:** nome, data de nascimento e um PIN de 4 números.
- **Entrar:** só nome e data. Se existir uma única conta com esse par, entra direto, sem PIN.
- **Empate:** se houver 2 ou mais contas com o mesmo nome e data, o app pede o PIN e abre a conta certa.
- O nome não diferencia maiúscula, acento nem espaços extras ("lúcas" = "Lucas").
- **Manter conectado** marcado: fica logado por 1 ano no aparelho. Desmarcado: a sessão some ao fechar o navegador e expira em 12h.
- Duas contas com mesmo nome, data **e** PIN não são aceitas.

Proteções ativas:
- O PIN fica guardado com hash, nunca em texto.
- 5 PINs errados em 15 minutos bloqueiam aquele nome + data por 15 minutos.
- Os tokens de sessão ficam guardados só como hash.
- O banco não é acessível de fora. Tudo passa pelo servidor, que confere quem está logado.
- Limites: ficha de até 1 MB por conta, fotos de até 600 KB cada (máx. 200 por conta).

> **Risco aceito por decisão de produto:** quem souber o nome e a data de nascimento de alguém que não tem "gêmeo" no banco entra na conta dessa pessoa sem PIN. Foi escolhido assim para ter entrada sem atrito. Para endurecer depois, basta exigir o PIN sempre na função `login` de `src/worker.js`.

## Plano grátis do Cloudflare

- 100 mil acessos por dia ao servidor, muito acima do uso de um grupo de amigos.
- Se passar do limite do dia, o banco para até a meia-noite (horário UTC) e os dados continuam salvos.
- Não pausa por falta de uso.

## Limites do navegador

- Com o app em segundo plano ou a tela bloqueada, o celular não toca o alarme do descanso. O tempo continua contando e o alarme toca ao voltar.
- No iPhone, com o modo silencioso ligado, os sons do app não tocam. Vibração não existe no iPhone pelo navegador.
- Fotos dos exercícios: Free Exercise DB (domínio público). 10 exercícios de mobilidade usam animação própria.
