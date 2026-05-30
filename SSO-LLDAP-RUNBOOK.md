# Central Login (LLDAP) — Stalwart + Nextcloud Runbook

Central, password-based identity for the `javanegra.com` mail stack. One credential per
user authenticates **Stalwart** (mail) and **Nextcloud** (login + auto-provisioned Mail).

> Server: `ssh javaserver` (103.27.206.36, Ubuntu 24.04, Dokploy + Traefik).
> Secrets live on the server only — none are committed to this repo.

## Why LLDAP (not Authentik / OIDC SSO)

Nextcloud Mail 5.8 only supports XOAUTH2 against Microsoft/Google — **not** generic OIDC.
To get "each user sees their own Stalwart inbox with zero setup", Nextcloud must log in with a
**password** it can replay to IMAP. So login is password-based against a shared LDAP backend.
That makes Authentik's OIDC machinery unused dead weight, so we run **LLDAP** (~<50 MB, single
container, SQLite, built-in admin UI) as the single source of truth instead.

## Architecture

```
                 LLDAP  (web UI: https://id.javanegra.com — needs DNS A record)
                 ├─ users + passwords (source of truth, SQLite)
                 └─ LDAP :3890
                        ▲                         ▲
        bind (password) │                         │ bind (password)
                 Stalwart (directory=LDAP)   Nextcloud (user_ldap "s01")
                 mail.javanegra.com           cloud.javanegra.com
                        ▲                         └─ Mail app provisioning (uses login pwd → IMAP)
                        └──────────── IMAP/SMTP ──────┘
```

Same password everywhere → Nextcloud Mail auto-authenticates to Stalwart → no per-user setup.

## Components

| Thing                       | Location                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLDAP stack                 | **Dokploy Compose service `lldap`** (project "Javanegra Mail Server", Raw provider). Container `lldap`, volume `lldap_data` (external → `lldap_lldap_data`), joined to dokploy + nextcloud + stalwart networks |
| LLDAP secrets               | inlined in the Dokploy compose `environment:` (`LLDAP_JWT_SECRET`, `LLDAP_KEY_SEED`, `LLDAP_LDAP_USER_PASS`) — edit there, then Deploy                                                                         |
| LLDAP config                | `/data/lldap_config.toml` **inside the `lldap_lldap_data` volume** (authoritative `key_seed`, matches the env value)                                                                                           |
| Service bind account pwd    | embedded in Stalwart's LDAP directory config + Nextcloud `s01` (account `svc-bind`)                                                                                                                            |
| Stalwart LDAP directory     | configured in webadmin → Settings › Authentication › Directories ("LLDAP"); stored in RocksDB                                                                                                                  |
| Nextcloud LDAP config       | `occ ldap:show-config s01`                                                                                                                                                                                     |
| Nextcloud Mail provisioning | DB row in `oc_mail_provisionings` (mariadb `nextcloud`)                                                                                                                                                        |

Base DN `dc=javanegra,dc=com`; users under `ou=people`, groups under `ou=groups`.

### Accounts of note

- **`postmaster`** — the LLDAP **bootstrap super-admin** (`LLDAP_LDAP_USER_DN=postmaster`) and a
  mail user. Use this to manage users in the web UI. Its password is **re-applied from the Dokploy
  compose env `LLDAP_LDAP_USER_PASS` on every container start** — to change it, edit that env in
  Dokploy and Deploy (changing it via the UI alone won't stick across restarts).
- **`admin-jvn`** — the real mailbox `admin@javanegra.com` as a normal mail user. (uid is `admin-jvn`
  rather than `admin`; Stalwart resolves the mailbox by the `mail` attribute, so the uid is free.)
  There is no separate `admin` account — `admin@javanegra.com` is just a regular user.
- **`svc-bind`** — read-only service account (`lldap_strict_readonly`) used by Stalwart and
  Nextcloud to search the directory.

## Key configuration values

**Stalwart LDAP directory** (webadmin):

- Server URL `ldap://lldap:3890`, Base DN `dc=javanegra,dc=com`
- Bind DN `uid=svc-bind,ou=people,dc=javanegra,dc=com` (+ secret value)
- **Use Bind Authentication = ON** (required — LLDAP uses OPAQUE and never exposes password hashes)
- Login filter `(&(objectClass=person)(|(mail=?)(uid=?)))`, Mailbox filter `(&(objectClass=person)(mail=?))`
- Then Settings › Authentication › General → **Authentication Directory = LLDAP**

**Nextcloud `user_ldap` (s01)** — set via `occ ldap:set-config s01 <key> <value>`:

- host `lldap` :3890, base `dc=javanegra,dc=com`, users `ou=people`, groups `ou=groups`
- agent `uid=svc-bind,ou=people,dc=javanegra,dc=com`
- login filter `(&(objectclass=person)(memberof=cn=mail-users,ou=groups,dc=javanegra,dc=com)(|(uid=%uid)(mail=%uid)))`
- user filter `(&(objectclass=person)(memberof=cn=mail-users,ou=groups,dc=javanegra,dc=com))`
- `ldapEmailAttribute=mail`, `ldapExpertUsernameAttr=uid`, `ldapUserDisplayName=displayname`

**Nextcloud Mail provisioning** (`oc_mail_provisionings`): domain `javanegra.com`, imap
`mail.javanegra.com:993 ssl`, smtp `mail.javanegra.com:465 ssl`, user `%EMAIL%`,
`master_password_enabled=0` (→ uses the user's login password).

## ⚠️ Why Nextcloud login got "stuck" and needed a refresh (fixed)

Symptom: after entering credentials the page stayed on `/login`; a manual refresh then landed you
in. Browser console showed `form-action 'self'` CSP violation, "request blocked".

Cause: Nextcloud sits behind Traefik which terminates TLS and forwards **http** to the container.
`overwriteprotocol` was unset and `overwrite.cli.url` was `http://…`, so Nextcloud generated
`http://` origins. The browser was on `https://`, so the login POST's redirect target counted as a
different origin and CSP `form-action 'self'` blocked it. The session cookie was already set, so a
GET refresh slipped through.

Fix applied (`occ config:system:set`):

- `overwriteprotocol = https`
- `overwrite.cli.url = https://cloud.javanegra.com`
- `trusted_proxies = [172.16.0.0/12, 10.0.0.0/8]`

### HSTS (Strict-Transport-Security) — set at Traefik, not Nextcloud

The NC "HTTP headers / HSTS not set" warning is a reverse-proxy concern. Added a **global** HSTS
middleware on Dokploy's Traefik `websecure` entrypoint (covers cloud + mail + id):

- `/etc/dokploy/traefik/dynamic/middlewares.yml` → added middleware `hsts` (`headers.stsSeconds: 15552000`,
  no `includeSubDomains`/`preload` → safe & reversible).
- `/etc/dokploy/traefik/traefik.yml` → `entryPoints.websecure.http.middlewares: [hsts@file]`.
- Static-config change → requires `docker restart dokploy-traefik` (brief routing blip). Backups:
  `traefik.yml.bak-hsts`, `dynamic/middlewares.yml.bak-hsts`. Verify: `curl -sD- https://cloud.javanegra.com/ | grep -i strict-transport`.
- NOTE: this edits Dokploy's own Traefik config; a Dokploy upgrade could reset it — re-apply if HSTS disappears.

### Other NC setup-warning fixes (all via `occ`, SSH)

`maintenance_window_start=20` (03:00 WIB) · `default_phone_region=ID` · `occ db:add-missing-indices` ·
`occ maintenance:repair --include-expensive` (mimetypes) · Redis for `memcache.locking`+`distributed`
(local stays APCu) · system SMTP (`mail_smtp*`) → Stalwart `mail.javanegra.com:465 ssl` as `postmaster@`.
Left as-is (optional/info): AppAPI deploy daemon, 2FA enforcement, Configuration server ID.

### Background jobs / cron (required for reliable Mail sync)

Nextcloud was in `ajax` background-jobs mode (jobs only run while a page is open) → Mail sync &
Priority-Inbox initialization lagged, surfacing console errors like `400 …view=threaded` +
"Mailbox … not cached. Triggering initialization" and `409 …/mailboxes/<id>/sync` (these are benign
init/concurrent-sync handshakes, not data loss). Fixed by switching to system cron:

- Host crontab (root): `*/5 * * * * docker exec -u www-data <nextcloud-container> php -f /var/www/html/cron.php >/dev/null 2>&1`
- `occ config:system:set backgroundjobs_mode --value cron`
- Host `cron` daemon is active+enabled. Verify it fires: `occ config:app:get core lastcron` should
  advance every ~5 min. NOTE: if the Nextcloud container is recreated with a new name, update the
  crontab line.

## Operations

**Add a user** → LLDAP web UI (`id.javanegra.com`, login `postmaster`): create user, set password,
add to group **`mail-users`**. They can immediately log into Nextcloud + see their mail. The
Stalwart mailbox materializes on first login or first inbound mail. Desktop clients (Thunderbird/
Outlook) use the same password (LDAP bind) — no OAuth needed.

**Verify auth end-to-end:**

```sh
# Stalwart IMAP via LLDAP
printf 'a LOGIN "user@javanegra.com" "PASS"\nb LOGOUT\n' | openssl s_client -quiet -connect 127.0.0.1:993
# Nextcloud sees the user
docker exec -u www-data <nc> php occ ldap:check-user <uid>
# svc-bind can read the directory
docker run --rm --network dokploy-network alpine sh -c 'apk add -q openldap-clients; ldapwhoami -x -H ldap://lldap:3890 -D uid=svc-bind,ou=people,dc=javanegra,dc=com -w "$(...)"'
```

## Nextcloud admin

The Nextcloud full admin is the **LLDAP** user `postmaster` (NC internal id `postmaster_1897` — got a
suffix because a local `postmaster` admin existed at install; that local account was deleted). Log in
at `cloud.javanegra.com` as **`postmaster@javanegra.com`** (use the email; the uid `postmaster_1897`
won't match the LDAP login filter) with the LLDAP postmaster password. There is no local admin
anymore — **break-glass = `occ`** inside the container, e.g. re-grant admin with
`docker exec -u www-data <nc> php occ group:adduser admin <uid>` or create a local admin via
`occ user:add --group=admin <name>`.

## Distribution lists (fan-out) — use Stalwart Mailing Lists, NOT LLDAP groups

In Stalwart, a **Group** = shared mailbox (mail lands in one box, no fan-out). A **Mailing List**
= fan-out to each member's own inbox. Since v0.10.7 mailing lists are **managed inside Stalwart**
(not from LDAP). Verified working with the external LLDAP directory, **live, no restart**:

- Create via webadmin → **Directory › Mailing Lists › Create**: set local part, pick domain,
  add recipient email addresses (the members' addresses, which resolve via LLDAP). Optional aliases.
- Mail to the list address fans out to each recipient's mailbox (confirmed: one message → ingested
  to each member's own accountId).
- Manage these in **Stalwart** (webadmin/CLI/JMAP), not LLDAP. LLDAP holds users; fan-out lists live
  in Stalwart.

Current lists (created as Stalwart Mailing Lists, fan-out verified):
`cofounder@`, `internal@`, `fin-adm@`, `fin-acc@`, `finance@`. The old shared-mailbox **Groups**
(same addresses + `website@`) were deleted. **`website@` has no list yet** — create one (Mailing
List) with its recipients when needed.

To create/edit a list fast in bulk, the webadmin posts JMAP `x:MailingList/set` to `/jmap/`
(`{create:{"new-0":{domainId, name, recipients:{"addr@dom":true,...}}}}`) with the session bearer
token — handy for scripting large membership. Deleting a Group that still has members requires
detaching members first (or the address stays occupied and blocks reusing it for a list).

> ⚠️ Stalwart has a **42 GB** RocksDB store. A hard/`docker restart` left ~137 unflushed WAL segments
> and triggered a ~20-min WAL recovery (mail down meanwhile). **Always stop gracefully**:
> `docker stop -t 120 <stalwart>` before starting, so WALs flush and startup is fast.

## Rollback

- **Stalwart → internal directory:** webadmin → Settings › Authentication › General → clear
  Authentication Directory (back to internal). Internal accounts/passwords are untouched.
- **Nextcloud LDAP off:** `occ ldap:set-config s01 ldapConfigurationActive 0` (and `occ app:disable user_ldap`).
- **Mail provisioning off:** `DELETE FROM oc_mail_provisionings;` in the `nextcloud` DB.
- **Stop/redeploy LLDAP:** use the Dokploy service `lldap` (Stop / Deploy buttons). To wipe the user
  DB, remove the `lldap_lldap_data` Docker volume after stopping.

## Notes / gotchas

- LLDAP user IDs cannot contain `@` — use the email local part as the uid and put the full address
  in the `mail` attribute. Stalwart matches mailboxes by `mail`, so uid naming is free.
- The bootstrap admin (`LLDAP_LDAP_USER_DN`, now `postmaster`) has its password re-applied from
  `LLDAP_LDAP_USER_PASS` on every start. LLDAP **requires** one bootstrap admin — you can't remove it;
  we point it at `postmaster` so there's no extra `admin` account.
- `key_seed` must be stable & identical across sources. The shipped template wrote a placeholder seed
  that conflicted with the env var, breaking OPAQUE password verification non-deterministically.
  Resolved by pinning the **same** real seed in both the volume's `/data/lldap_config.toml` and the
  compose `LLDAP_KEY_SEED` env. Never change the seed or all stored passwords stop verifying.
- The LLDAP data volume `lldap_lldap_data` is referenced **external** by the Dokploy compose, so it
  survives redeploys and was carried over from the original manual deployment without data loss.
- Stalwart management REST API (`/api/*`) requires an **OAuth bearer** token and is driven over
  **JMAP** by the webadmin; Basic auth returns 404. Use the webadmin UI for config changes.
