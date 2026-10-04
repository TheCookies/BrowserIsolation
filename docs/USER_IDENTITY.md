# User identity and persistent browser profiles

This document explains how portal users are identified for **data ownership**
(preferences and Docker profile volumes), and how local auth and SAML share the
same storage model. For the full doc set, see [README.md](README.md).

## Concepts

| Field | Purpose | Example (local) | Example (SAML) |
| --- | --- | --- | --- |
| `username` | Display / login label shown in the UI | `alice` | `alice@example.com` |
| `subjectId` | Stable ownership key for prefs + volumes | `local:alice` | `saml:urn:oasis:…:alice@example.com` |
| `profileStorageKey` | Path-safe hash of `subjectId` | `a1b2…` (32 hex chars) | same derivation |

**Rule:** preferences and Docker volumes are keyed by `subjectId` (via
`profileStorageKey`), never by display username alone.

## Local auth (current)

Local accounts live in SQLite (`local_users`), not permanently in `.env`.

1. On first boot with an empty `local_users` table, `AUTH_USERS` seeds the database.
2. After that, manage users in **Admin → Users** (add / role / reset password / delete).
3. `orchestrator/src/auth/local-provider.ts` authenticates against the DB and returns:

```ts
{ username, role, subjectId } // subjectId is local:<username>
```

Helpers live in `orchestrator/src/auth/identity.ts`. When SAML is added, keep this local
store as an optional break-glass admin path or disable it via config.

## Persistent profiles

1. Admin enables the feature with `PERSIST_PROFILES_ENABLED=true` (default).
2. Each user may opt in via **Dashboard → Persist browser settings** (`PUT /api/preferences`).
3. Preference is stored in SQLite `user_preferences.subject_id`.
4. On launch with persistence on, the orchestrator mounts a **Docker named volume**:

   ```text
   rbi-profile-<profileStorageKey>-<browser>
   ```

   Examples:

   - `rbi-profile-<hash>-chrome`
   - `rbi-profile-<hash>-firefox`
   - `rbi-profile-<hash>-brave`

5. Volume target paths inside Neko containers (see Neko browser docs):

   | Browser | Container path |
   | --- | --- |
   | chrome | `/home/neko/.config/google-chrome` |
   | brave | `/home/neko/.config/brave` |
   | firefox | `/home/neko/.mozilla/firefox/profile.default` |

6. Persist-mode also uses `orchestrator/neko-policies/<browser>/policies.persist.json`
   so cookies/session data are not wiped on browser exit.

Turning persistence **off** does not delete volumes (data remains if the user
opts back in). Destroying a browser session removes the container only, not the
profile volume.

### Inspecting volumes

```bash
docker volume ls --filter label=rbi.managed=true
docker volume inspect rbi-profile-<key>-chrome
```

Labels on each volume:

- `rbi.managed=true`
- `rbi.subject_key=<profileStorageKey>`
- `rbi.browser=<chrome|firefox|brave>`

## SAML / SSO (implemented)

Configure under **Admin → Settings → SSO / SAML** (or matching `.env` keys).
Implementation lives in `orchestrator/src/auth/saml.ts` and auth routes.

| Setting | Purpose |
| --- | --- |
| `SAML_ENABLED` | Master switch |
| `PUBLIC_BASE_URL` | Canonical portal origin (`https://rbi.example.com`) |
| `SAML_ENTRY_POINT` | IdP SSO URL |
| `SAML_IDP_CERT` | IdP X.509 signing certificate |
| `SAML_IDP_ENTITY_ID` | Optional IdP issuer |
| `SAML_SP_ENTITY_ID` | Optional; default `{PUBLIC_BASE_URL}/saml/metadata` |
| `SAML_USERNAME_ATTR` / `SAML_GROUPS_ATTR` | Optional attribute overrides |
| `SAML_ADMIN_GROUP` | Group value that grants `admin` (case-insensitive) |

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/methods` | `{ local, saml }` for the login page |
| `GET` | `/api/auth/saml/login` | Redirects to the IdP |
| `POST` | `/api/auth/saml/acs` | Assertion consumer (IdP POST) |
| `GET` | `/saml/metadata` | SP metadata XML |

Local username/password login remains available as break-glass. First SSO
sign-in auto-provisions as `user` unless `SAML_ADMIN_GROUP` matches; SAML users
are **not** inserted into `local_users` (Admin → Users stays local-only).
Preferences and profile volumes still key on `subjectId` (`saml:…`).

Existing `local:…` profile volumes are not renamed automatically when the same
people later sign in via SAML — keep legacy rows or run a one-off copy/rename
using recomputed `profileStorageKey` values.

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/me` | Includes `subjectId`, `persistProfile`, `persistProfilesEnabled` |
| `GET` | `/api/preferences` | Current user's persist flag |
| `PUT` | `/api/preferences` | Body `{ "persistProfile": boolean }` |

Preference changes apply on the **next** browser launch (disconnect + launch
again if a session is already running).
