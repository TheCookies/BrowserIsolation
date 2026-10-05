# Web

React SPA for Browser Isolation: login, launch dashboard, WebRTC session viewer, and admin console.

Built with **React 19**, **React Router 7**, and **Vite 7**. In production the orchestrator serves `web/dist` as static files.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| Dev | `npm run dev -w web` | Vite on `http://localhost:5173` |
| Build | `npm run build -w web` | Typecheck + Vite production build |
| Preview | `npm run preview -w web` | Serve the production build locally |

Prefer `npm run dev` from the **repo root** so the API and UI start together (Node.js **26+**).

## Dev proxy

`vite.config.ts` proxies:

- `/api` → `http://127.0.0.1:8080`
- `/session/:id/view/*` (including WebSocket) → API  
- `/session/:id` (no `/view`) stays on Vite so the SPA shell loads

Cookies and CSRF work same-origin through the proxy. (Logo at `/branding/logo` is served by the orchestrator; in production the SPA and API share an origin.)


## Source layout

```text
src/
  main.tsx          # Bootstrap
  App.tsx           # Routes + auth gate
  api.ts            # Typed fetch client + CSRF
  Shell.tsx         # Shared chrome (incl. theme)
  styles.css
  pages/
    Login.tsx
    Dashboard.tsx
    Session.tsx
    Admin.tsx
    admin/          # Admin feature tabs (settings, branding, workers, …)
  viewer/           # Custom Neko WebRTC client
  SessionFiles.tsx  # Optional file transfer UI
public/             # Static assets (e.g. browser logos)
```

## Routes

| Path | Component |
| --- | --- |
| `/login` | `LoginPage` |
| `/` | `DashboardPage` |
| `/session/:sessionId` | `SessionPage` |
| `/admin/*` | Admin layout + nested pages |

Admin routes redirect non-admins to `/`. The API also enforces admin role.

## Talking to the API

All calls go through `api.ts`:

- Reads `csrfToken` from `/api/me` (or `/api/auth/csrf` on login)  
- Sends `X-CSRF-Token` on mutating methods  
- Uses `credentials: "include"` for the portal cookie  

When you add a backend route, add a typed helper here and call it from the page.

Notable UX wired to preferences / auth:

- **Dark mode** — `darkMode` on `/api/me` + `PUT /api/preferences`  
- **Change password** — when `canChangePassword` is true (local users)  
- **Branding** — login/shell use `logoUrl`; admins upload via Admin → Settings / branding APIs  

## Viewer

`viewer/RemoteDesktop.tsx` mounts the stream. Under the hood:

1. Parent page fetches access credentials (`POST /api/sessions/:id/access` or admin join).  
2. Client opens WebSocket to `wsPath` (`/session/:id/view/ws`) with Neko username/password.  
3. WebRTC media uses ICE servers from the access response; candidates advertise the worker `PUBLIC_IP`.  

Keyboard mapping includes Guacamole-derived code under Apache 2.0 (`LICENSE-APACHE-2.0`, `NOTICE`).

## UI notes

- Fonts: IBM Plex Sans + Space Grotesk (`@fontsource/*`).  
- Keep admin pages thin: data fetching in the page, shared helpers in `pages/admin/format.ts` / `context.ts`.  
- There is no automated frontend test suite yet; verify changes with `npm run dev`.

## Further reading

- [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)  
- [../docs/API.md](../docs/API.md)  
- [../docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md)  
