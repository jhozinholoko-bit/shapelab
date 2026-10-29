# ShapeLab · versão app

App de treino que roda no navegador do celular e pode ser instalado na tela inicial.
Os dados ficam num banco Supabase (gratuito). Esta versão não tem Coach IA, então não há custo de API.

## O que tem na pasta

| Arquivo | Para que serve |
|---|---|
| `index.html` | O app |
| `shapelab-api.js` | Telas de entrar e criar conta, e ligação com o banco |
| `config.js` | **Você preenche:** endereço e chave do Supabase |
| `ex/` | Fotos dos exercícios (Free Exercise DB, domínio público) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalação no celular (PWA) |
| `supabase/schema.sql` | Tabelas e regras de login do banco |

## Como publicar (uns 15 minutos)

**1. Criar o banco**
1. Crie uma conta em supabase.com e clique em **New project**.
2. Abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Em **Project Settings → API**, copie a **Project URL** e a chave **anon public**.

**2. Ligar o app ao banco**
Abra `config.js` e cole os dois valores:
```js
window.SHAPELAB_CONFIG = {
  supabaseUrl: "https://SEU-PROJETO.supabase.co",
  supabaseAnonKey: "eyJ..."
};
```

**3. Colocar no ar**
Entre em app.netlify.com/drop e arraste a pasta inteira (a pasta `supabase` não precisa ir, mas não atrapalha).
Na Vercel funciona igual: **Add New → Project → upload** da pasta. Você recebe um link `https://...`.

**4. Instalar no celular**
- iPhone (Safari): botão Compartilhar → **Adicionar à Tela de Início**.
- Android (Chrome): menu ⋮ → **Instalar app**.

## Como funciona o login

- **Criar conta:** nome, data de nascimento e um PIN de 4 números.
- **Entrar:** só nome e data. Se existir uma única conta com esse par, entra direto, sem PIN.
- **Empate:** se houver 2 ou mais contas com o mesmo nome e data, o app pede o PIN e abre a conta certa.
- Nome não diferencia maiúscula, acento nem espaços extras ("lúcas" = "Lucas").
- **Manter conectado** marcado: fica logado por 1 ano neste aparelho. Desmarcado: a sessão some ao fechar o navegador (e expira em 12h).
- Duas contas com mesmo nome, data **e** PIN não são aceitas.

Proteções que continuam ativas:
- PIN guardado criptografado (bcrypt), nunca em texto.
- 5 PINs errados em 15 minutos bloqueiam aquele nome+data por 15 minutos.
- O app não acessa as tabelas diretamente; tudo passa pelas funções do `schema.sql`.
- Fotos de até 600 KB cada e ficha de até 1 MB por conta.

> **Risco aceito por decisão de produto:** quem souber o nome e a data de nascimento de alguém que não tem "gêmeo" no banco entra na conta dessa pessoa sem PIN. Foi escolhido assim para ter entrada sem atrito. Para endurecer depois, basta exigir o PIN sempre na função `login` do `schema.sql`.

## Limites do navegador
- Com o app em segundo plano ou a tela bloqueada, o celular não toca o alarme do descanso; o tempo continua contando e o alarme toca ao voltar.
- Vibração não existe no iPhone pelo navegador.
