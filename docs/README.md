# Documentation index

## Pretty HTML (recommended)

Open the generated site in a browser:

- File: [`site/index.html`](site/index.html)
- Or from the repo root: `npm run docs:serve` → http://localhost:4173

Rebuild after editing markdown: `npm run docs`

## Markdown onboarding path

1. [../README.md](../README.md) — what this is and how to run it  
2. [ARCHITECTURE.md](ARCHITECTURE.md) — system design  
3. [DEVELOPMENT.md](DEVELOPMENT.md) — day-to-day coding  
4. [API.md](API.md) — contracts you will call or extend  
5. Package READMEs: [orchestrator](../orchestrator/README.md) · [web](../web/README.md)

## Operations

| Doc | When you need it |
| --- | --- |
| [SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md) | **Start here:** publish image + Alma Linux pull/auto-start |
| [PODMAN.md](PODMAN.md) | GHCR / Podman background and reference |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production install, TLS, firewall, TURN |
| [WORKERS.md](WORKERS.md) | Scaling browsers across hosts |
| [USER_IDENTITY.md](USER_IDENTITY.md) | Profiles, `subjectId`, SAML |
| [SECURITY.md](SECURITY.md) | Threat model, defaults, trust boundaries |
## Product

| Doc | When you need it |
| --- | --- |
| [PLAN.md](PLAN.md) | What is done, what is next, design decisions |

## Config reference

All environment variables live in [../.env.example](../.env.example) with inline comments. Prefer that file over duplicating every knob here.
