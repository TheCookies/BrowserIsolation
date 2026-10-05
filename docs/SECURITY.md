# Security notes

Browser Isolation is a security product. Treat defaults as intentional and review this page before widening trust boundaries.

## Threat model (summary)

| In scope | Out of scope (today) |
| --- | --- |
| Malicious web content inside the isolated browser | Fully malicious admin with Docker/Podman socket access |
| Cross-user session access via the portal | Client-side malware on the user’s machine |
| Casual data exfil via clipboard/files when disabled | Perfect anonymity / anti-fingerprinting of Neko itself |

The user’s endpoint should only receive a media stream and input events, not render untrusted HTML/JS from the target site.

## Hardening defaults

| Control | Default | Notes |
| --- | --- | --- |
| Clipboard sync | Off (`ALLOW_CLIPBOARD=false`) | Admin → Settings → Security |
| Downloads / file transfer | Off (`ALLOW_DOWNLOADS=false`) | Same |
| CSRF | On for mutating `/api/*` | SAML ACS + worker enroll exempt by necessity |
| Session cookie | httpOnly, SameSite=Lax | Set `COOKIE_SECURE` under HTTPS |
| Browser ACL | Owner or admin | Enforced in API and view proxy |
| Managed policies | Injected at create | Removes SponsorBlock force-install; keeps uBlock |
| Worker agent | Bearer token | Must not be public |
| Alma installers | `--privileged` + socket | Host-equivalent power — treat hosts as trusted |

## Trust boundaries

```text
[ User browser ]  --trusted UI/API-->  [ Orchestrator ]
        |                                     |
        | WebRTC (media)                      | Docker/Podman socket / worker Bearer
        v                                     v
[ Worker PUBLIC_IP ]  <----- container ---->  [ Neko / target web ]
```

- Anyone who can call the container socket or forge `WORKER_ENROLL_TOKEN` / `WORKER_TOKEN` can run arbitrary containers on that host.  
- Install scripts for this deployment bake GHCR credentials and the enroll secret — rotate them if leaked, and do not publish script copies to untrusted places.  
- `--privileged` + mounted `podman.sock` is intentional for Alma browser hosts; it is **not** a multi-tenant isolation boundary between co-admins on the same host.  
- Admins can join any session (by design); audit those actions.  
- SAML trust depends on IdP certificate configuration and `PUBLIC_BASE_URL`.

## Operational checklist

See the checklist in [DEPLOYMENT.md](DEPLOYMENT.md#security-checklist). In short: HTTPS, rotate defaults, lock down agent ports, keep exfil toggles off unless required, back up SQLite deliberately.

## Reporting issues

If you find a vulnerability in this project, do not open a public issue with exploit details. Contact the maintainers privately with reproduction steps and impact.
