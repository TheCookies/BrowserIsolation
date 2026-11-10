# User identity and persistent browser profiles

This document explains how portal users are identified for **data ownership**
(preferences and Docker profile volumes), and how local auth and SAML share the
same storage model. For the full doc set, see [README.md](README.md).

## Concepts

| Field | Purpose | Example (local) | Example (SAML) | Example (LDAP) |
| --- | --- | --- | --- | --- |
| `username` | Display / login label shown in the UI | `alice` | `alice@example.com` | `alice` |
| `subjectId` | Stable ownership key for prefs + volumes | `local:alice` | `saml:urn:oasis:…:alice@example.com` | `ldap:<objectGUID>` |
| `profileStorageKey` | Path-safe hash of `subjectId` | `a1b2…` (32 hex chars) | same derivation | same derivation |

**Rule:** preferences and Docker volumes are keyed by `subjectId` (via
`profileStorageKey`), never by display username alone.

## Local auth

Local accounts live in SQLite (`local_users`), not permanently in `.env`.

1. On first boot with an empty `local_users` table, `AUTH_USERS` seeds the database.
2. After that, manage users in **Admin → Users** (add / role / reset password / delete).
3. Local users can change their own password via `POST /api/auth/password` when `canChangePassword` is true on `/api/me`.
4. `orchestrator/src/auth/local-provider.ts` authenticates against the DB and returns:

```ts
{ username, role, subjectId } // subjectId is local:<username>
```

Helpers live in `orchestrator/src/auth/identity.ts`. Keep the local store as an
optional break-glass admin path when SAML is enabled, or disable it via config later.

## Preferences

Stored in SQLite `user_preferences` per `subject_id`:

| Field | Purpose |
| --- | --- |
| `persist_profile` | Mount a named volume on next browser launch |
| `dark_mode` | SPA theme preference |

API: `GET` / `PUT /api/preferences` with `{ persistProfile?, darkMode? }`.

## Persistent profiles

1. Admin enables the feature with `PERSIST_PROFILES_ENABLED=true` (default).
2. Each user may opt in via **Dashboard → Persist browser settings** (`PUT /api/preferences`).
3. On launch with persistence on, the orchestrator bind-mounts a **host directory** (Alma/VM install) or a named volume (Compose):

   ```text
   /var/lib/browser-isolation/profiles/<profileStorageKey>/<browserId>
   ```

   That path is on the machine’s HDD. Destroying the browser container, logging out, or auto-updating the portal does **not** delete it.

   Compose without `PROFILE_DATA_DIR` still uses a named volume `rbi-profile-<hash>-<browserId>` (also on disk, under the engine’s volume store).

4. Volume target paths inside Neko containers:

   | Browser id | Container path |
   | --- | --- |
   | `google-chrome` | `/home/neko/.config/google-chrome` |
   | `brave` | `/home/neko/.config/brave` |
   | `firefox` | `/home/neko/.mozilla/firefox/profile.default` |

5. Persist-mode also uses `orchestrator/neko-policies/<browser>/policies.persist.json`
   so cookies/session data are not wiped on browser exit.

Turning persistence **off** does not delete volumes (data remains if the user
opts back in). Destroying a browser session removes the container only, not the
profile volume. Multi-host: volumes stick to the worker recorded in
`profile_placements` (see [WORKERS.md](WORKERS.md)).

### Inspecting volumes

```bash
# Alma / VM installer
ls /var/lib/browser-isolation/profiles
ls /var/lib/browser-isolation/data          # portal SQLite + branding

# Compose named volumes
podman volume ls --filter label=rbi.managed=true
podman volume inspect rbi-profile-<key>-google-chrome
```

Labels on each volume:

- `rbi.managed=true`
- `rbi.subject_key=<profileStorageKey>`
- `rbi.browser=<google-chrome|firefox|brave|…>`

## SAML / SSO (implemented)

Configure under **Admin → Settings → Sign-in** (or matching `.env` keys).
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
| `GET` | `/api/auth/methods` | `{ local, saml, ldap }` for the login page |
| `GET` | `/api/auth/saml/login` | Redirects to the IdP |
| `POST` | `/api/auth/saml/acs` | Assertion consumer (IdP POST; CSRF exempt) |
| `GET` | `/saml/metadata` | SP metadata XML |

Local username/password login remains available as break-glass. First SSO
sign-in auto-provisions as `user` unless `SAML_ADMIN_GROUP` matches; SAML users
are **not** inserted into `local_users` (Admin → Users stays local-only).
`canChangePassword` is false for SAML subjects. Preferences and profile volumes
still key on `subjectId` (`saml:…`).

Existing `local:…` profile volumes are not renamed automatically when the same
people later sign in via SAML — keep legacy rows or run a one-off copy/rename
using recomputed `profileStorageKey` values.

## LDAP / Active Directory (implemented)

Additive password login against LDAP/LDAPS. Configure under **Admin → Settings → Sign-in**
(or matching `.env` keys). Implementation: `orchestrator/src/auth/ldap-provider.ts`
plus a local-first composite in `composite-provider.ts`.

| Setting | Purpose |
| --- | --- |
| `LDAP_ENABLED` | Master switch |
| `LDAP_URL` | `ldap://` or `ldaps://` URI (prefer LDAPS) |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` | Service account used to search |
| `LDAP_SEARCH_BASE` | Search base DN |
| `LDAP_SEARCH_FILTER` | Filter with `{{username}}` (AD defaults if blank) |
| `LDAP_USERNAME_ATTR` | Display username (default `sAMAccountName`) |
| `LDAP_GROUPS_ATTR` | Groups attribute (default `memberOf`) |
| `LDAP_ADMIN_GROUP` | CN names (comma-separated) and/or full DNs (semicolon-separated) that grant `admin` |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | Require trusted LDAPS certs (default `true`) |

**Local precedence:** if the username exists in `local_users`, only local auth runs
(no LDAP fall-through). That keeps break-glass admins intact and avoids dual
`local:` / `ldap:` identities for the same name.

LDAP users are **not** inserted into `local_users`. `subjectId` is
`ldap:<objectGUID>` when available, otherwise `ldap:<DN>`. `canChangePassword`
is false for LDAP subjects. The orchestrator host must reach the domain
controller; no public IdP callback / VIP is required for LDAP bind.

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/me` | Includes `subjectId`, `persistProfile`, `darkMode`, `canChangePassword`, … |
| `GET` | `/api/preferences` | Current user's persist + dark-mode flags |
| `PUT` | `/api/preferences` | Body `{ "persistProfile"?: boolean, "darkMode"?: boolean }` |
| `POST` | `/api/auth/password` | Local users only |

Preference changes for profiles apply on the **next** browser launch (disconnect +
launch again if a session is already running).
