# Deploying the playground

`apps/web` is a fully static site: a page plus one JavaScript bundle. There is no server, no
serverless function and no environment variable to set, because parsing an intent is pure
computation — a grammar, a symbol catalog, unit conversion and hashing. It runs in the visitor's
browser and never signs, submits or holds anything.

That is also why it is safe to host publicly: there is nothing to leak and nothing to spend.

## Vercel

Import `ezekiel6262/useweesh` at [vercel.com/new](https://vercel.com/new). The **repo-root**
`vercel.json` is enough — do not set a Root Directory:

| Setting | Value |
|---|---|
| Root Directory | _empty_ (repository root) |
| Framework Preset | Other |
| Build Command | `npm run build:web` |
| Output Directory | `apps/web/public` |
| Install Command | `npm install` |

No environment variables are required. The playground is a static grammar parser plus an
auction preview; it never signs or submits.

If you instead set Root Directory to `apps/web`, that package's own `vercel.json` still works
as long as the install can see the workspace packages (`@intentos/intent-ai`,
`@intentos/intent-schema`). Prefer the repo-root settings above.

> If the Vercel MCP connector reports `You don't have permission to create the project`, the
> connected account is not an Owner or Member with project-create rights on that team. Either
> import the repo from the dashboard as above, or update the role under
> [team members and roles](https://vercel.com/docs/accounts/team-members-and-roles) and retry.

## Anywhere else

The build output is plain static files, so any static host works:

```bash
npm install
npm run build -w @intentos/web   # writes apps/web/public/app.js
# then serve apps/web/public/ with anything
npx serve apps/web/public
```

## Hosting the full coordinator instead

The playground is deliberately only the first step of the loop. The coordinator (`apps/api`) and
the solvers (`apps/solver-agent`) are **long-running processes that hold keys** — they watch the
chain, close auctions on a timer, and sign transactions. Serverless is the wrong shape for them:
there is no persistent process to run the auction loop, and the intent mempool would be discarded
between invocations.

Host those on something that keeps a process alive (Railway, Fly, Render, a VM), with:

```bash
INTENTOS_NETWORK=xlayerTestnet
INTENTOS_RPC=https://testrpc.xlayer.tech
COORDINATOR_PRIVATE_KEY=…    # the auctioneer; bonded and challengeable
ANTHROPIC_API_KEY=…          # optional — enables the Claude parser
```

That path needs contracts on X Layer first — see [xlayer.md](xlayer.md), which also covers the
three things that must not be guessed before mainnet.
