# Product plan

This document is the map of **what is built**, **why**, and **sensible next steps** so a new contributor can prioritize work without rediscovering history from git alone.

## Vision

Provide a self-hosted remote browser isolation portal that is:

- Simple to run (Compose or Alma install scripts + SQLite, no Kubernetes required)  
- Safe by default (ACL proxy, optional clipboard/downloads off, managed browser policies)  
- Extensible to multi-host capacity and enterprise SSO  

Users never browse the open web on their endpoint; they interact with a streamed desktop inside a disposable (or optionally persistent) container.

---

## Implemented phases

Rough historical shape (all of these are in the tree today):

| Phase | Delivered |
| --- | --- |
| **1 — Portal & auth** | Local login, roles, CSRF, dashboard shell |
| **2 — Browser lifecycle** | Docker/Neko launch, one session per user, destroy on logout |
| **3 — Viewer** | Custom WebRTC client, session proxy, ICE / port pool |
| **4 — Admin & ops** | Join/terminate, audit, settings store, browser catalog, users |
| **5 — Hardening & scale** | Idle reaper, reconcile on restart, persistent profiles, SAML, multi-host workers |

If you see older comments referring to “phases 1–5”, that is this checklist.

---

## Current capabilities (checklist)

### Control plane

- [x] Fastify API + static SPA in one container (Node 26 image)  
- [x] SQLite persistence (sessions, users, settings, audit, workers, grants)  
- [x] Admin settings overlay on `.env`  
- [x] Health endpoint for Compose / installers  
- [x] Branding logo (Admin upload; served at `/branding/logo`)  
- [x] Dark mode preference per user  

### Auth & identity

- [x] Local users in DB (`AUTH_USERS` seed once)  
- [x] Change own password (local users)  
- [x] SAML 2.0 SSO + SP metadata  
- [x] Stable `subjectId` for preferences / volumes  
- [x] CSRF on mutating API routes  

### Isolation

- [x] Neko catalog (Firefox family + Chromium family)  
- [x] Managed policies (SponsorBlock removed; uBlock kept)  
- [x] Resource limits (CPU, memory, shm)  
- [x] Optional persistent profile volumes  
- [x] Clipboard / download gates  
- [x] `BROWSER_NETWORK_MODE=bridge|host`  

### Streaming

- [x] Same-origin signaling proxy with ACL  
- [x] WebRTC mux port pool  
- [x] Viewer viewport `screen/set`  
- [x] Optional ICE / TURN JSON config  

### Operations

- [x] Idle + max-lifetime reaper  
- [x] Restart reconciliation  
- [x] Admin join / terminate + audit  
- [x] Multi-host workers + self-enroll + Authorize + `worker_grants`  
- [x] Profile volume admin  
- [x] GHCR publish (Actions) + Alma install scripts (`deploy/podman/`)  

---

## Design decisions worth remembering

1. **SQLite over Postgres** — one-node ops simplicity; workers are remote Docker hosts, not another DB.  
2. **One session per user** — simplifies ACL and UX; reconnect instead of multi-tab containers.  
3. **Proxy signaling, not media** — orchestrator stays on the path for auth; media scales with worker NICs.  
4. **`subjectId` ≠ username** — storage survives display-name / IdP changes; see [USER_IDENTITY.md](USER_IDENTITY.md).  
5. **Policies as files** — `neko-policies/` injected at create time; persist mode uses `policies.persist.json`.  
6. **Admin settings in SQLite** — ops can tune without redeploying; a small set of infra keys stay env-only.  
7. **Same image, `RBI_ROLE`** — portal and worker share one GHCR artifact; entrypoint switches process.  
8. **Host network on Alma** — installers default `BROWSER_NETWORK_MODE=host` so WebRTC ports are reachable.  
9. **Shared enroll token** — `WORKER_ENROLL_TOKEN` is both enroll secret and agent Bearer (avoids per-host secret drift).

---

## Suggested next work (not commitments)

Use this as a backlog seed, not a promise:

| Area | Ideas |
| --- | --- |
| **Reliability** | TURN-first presets; better client-facing error UX for ICE failure |
| **Security** | Optional disable local login when SAML is on; rotate baked install-script secrets; session recording off-by-default policy packs |
| **Scale** | Fairer placement (CPU/mem, not only session count); autoscaling worker pools |
| **Observability** | Prometheus metrics; structured audit export |
| **UX** | Multi-monitor / resolution presets; browser language packs |
| **Testing** | Frontend smoke tests; more integration coverage for workers |
| **Packaging** | Align or retire Quadlet units vs host-network installers; optional Helm |

Before starting a large feature, skim [ARCHITECTURE.md](ARCHITECTURE.md) and the relevant package README so you extend the existing seams (routes → stores → Docker/worker) instead of inventing a parallel path.

---

## How to propose a change

1. Note the user-facing outcome in a short design note (or PR description).  
2. Prefer extending `settings-fields.ts` / admin UI for tunables.  
3. Add or update orchestrator tests for behavior changes.  
4. Update docs in the same PR when contracts or ops steps change, then run `npm run docs`.

See [../CONTRIBUTING.md](../CONTRIBUTING.md).
