# Contributing

Thanks for helping improve Browser Isolation. This guide keeps changes reviewable and safe for a security-sensitive project.

## Before you start

1. Read [README.md](README.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).  
2. Skim [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) so you know which package owns the change.  
3. For product context, see [docs/PLAN.md](docs/PLAN.md).

## Development workflow

```bash
cp .env.example .env   # if you do not have one
npm install            # requires Node.js 26+
npm test
npm run dev
```

- Prefer small, focused PRs.  
- Match existing TypeScript style and error-code patterns.  
- Do not commit secrets, `.env`, or SQLite files under `data/`.

## Tests

Orchestrator changes that touch behavior should include or update tests under `orchestrator/test/`:

```bash
npm test
```

Optional real-container test (needs Podman/Docker + images):

```bash
RBI_INTEGRATION=1 npm test -w orchestrator -- test/integration.test.ts
```

## Documentation

If you change:

| Change | Update |
| --- | --- |
| Env vars | `.env.example` (+ Admin settings fields if editable) |
| HTTP routes | `docs/API.md` |
| Deploy / networking | `docs/DEPLOYMENT.md`, `docs/WORKERS.md`, and/or `docs/SETUP_GHCR_ALMA.md` |
| Install scripts / entrypoint | `deploy/podman/README.md`, `docs/PODMAN.md`, `docs/SETUP_GHCR_ALMA.md` |
| Identity / profiles | `docs/USER_IDENTITY.md` |
| Architecture / modules | `docs/ARCHITECTURE.md` |
| Security defaults / trust | `docs/SECURITY.md` |
| Onboarding entry points | `README.md` / package READMEs |
| Any markdown under `docs/` | Run `npm run docs` to refresh `docs/site/index.html` |

## Security expectations

- Never expose the container socket or worker agent ports to the public internet in examples.  
- Keep CSRF, ACL, and role checks intact when adding routes.  
- Default to deny for clipboard, downloads, and other data exfil paths.  
- Treat `WORKER_ENROLL_TOKEN`, `WORKER_TOKEN`, Neko passwords, GHCR tokens in install scripts, and SAML certificates as secrets in docs and logs.

## Pull requests

- Describe **why** the change exists, not only what files moved.  
- List test commands you ran.  
- Call out any migration or ops step operators must take after deploy.
