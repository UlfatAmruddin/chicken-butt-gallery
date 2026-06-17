# Deploying Chicken Butt Gallery to the open internet

This app is a single Node.js process that serves both the API and the static
frontend. It must run **behind a TLS-terminating reverse proxy** — never expose
the Node port directly. The steps below use a Linux VPS with Caddy (automatic
HTTPS) and systemd. Ready-made config lives in [`deploy/`](deploy/).

## 0. Prerequisites

- A domain name with a DNS `A`/`AAAA` record pointing at your server.
- A Linux server (Ubuntu/Debian assumed) with **Node.js ≥ 18** installed.
- Ports **80** and **443** open to the internet; port **8173** open only to localhost.

## 1. Put the code on the server

```bash
sudo mkdir -p /opt/phantom-gallery
sudo useradd --system --home /opt/phantom-gallery --shell /usr/sbin/nologin gallery
# copy the project into /opt/phantom-gallery (scp, git clone, rsync, etc.)
sudo chown -R gallery:gallery /opt/phantom-gallery
```

There are **no npm dependencies to install** — the server uses only the Node
standard library, and Three.js/GSAP are vendored under `js/vendor/`.

## 2. Configure environment

```bash
cd /opt/phantom-gallery
sudo -u gallery cp .env.example .env
sudo -u gallery nano .env
# Restrict the env file — it must not be world-readable
sudo chmod 600 .env && sudo chown gallery:gallery .env
```

For a public deployment set at least:

```
HOST=127.0.0.1        # only the proxy can reach Node
TRUST_PROXY=1         # Caddy/nginx sets X-Forwarded-For
ENABLE_HSTS=1
ADMIN_USERNAMES=yourname
MIN_PASSWORD_LEN=8
```

> **Why `TRUST_PROXY=1` matters:** rate limiting keys on client IP. Behind a
> proxy, the real IP arrives in `X-Forwarded-For`. The app trusts that header
> **only** when `TRUST_PROXY=1`, so a direct attacker cannot spoof it to dodge
> limits.

## 3. Run as a service

```bash
sudo cp deploy/phantom-gallery.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phantom-gallery
sudo systemctl status phantom-gallery        # should be active (running)
curl -s http://127.0.0.1:8173/healthz        # -> {"ok":true}
```

The unit is sandboxed (`ProtectSystem=strict`, `NoNewPrivileges`, write access
limited to `data/`, `assets/`, `backups/`).

## 4. TLS reverse proxy (Caddy — automatic HTTPS)

```bash
# install Caddy: https://caddyserver.com/docs/install
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # set your real domain
sudo systemctl reload caddy
```

Caddy obtains and renews a Let's Encrypt certificate automatically. Visit
`https://your-domain` — you should see the gallery.

<details>
<summary>nginx alternative</summary>

```nginx
server {
    listen 443 ssl http2;
    server_name gallery.example.com;
    ssl_certificate     /etc/letsencrypt/live/gallery.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gallery.example.com/privkey.pem;
    client_max_body_size 16m;          # uploads are base64 JSON bodies
    location / {
        proxy_pass http://127.0.0.1:8173;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```
Use certbot for the certificate. Set `client_max_body_size` ≥ 16m or large uploads 413.
</details>

## 5. Firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
# do NOT allow 8173 — it stays bound to 127.0.0.1
```

## 6. Backups

```bash
sudo cp deploy/phantom-gallery-backup.service /etc/systemd/system/
sudo cp deploy/phantom-gallery-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phantom-gallery-backup.timer
sudo systemctl start phantom-gallery-backup.service   # test it once
ls /opt/phantom-gallery/backups/                      # timestamped snapshot
```

Snapshots of `data/` + `assets/` are written daily at 03:30; the 14 most recent
are kept. Copy them off-box periodically (`rsync`, object storage) for real
disaster recovery.

## 7. Updating

```bash
cd /opt/phantom-gallery
# pull/copy new code
sudo chown -R gallery:gallery .
sudo systemctl restart phantom-gallery
```

`data/` and `assets/` are untouched by code updates. Run `npm test` before
restarting if you changed backend logic.

## Windows note

For a Windows host, run `node server.js` under a process manager such as
[NSSM](https://nssm.cc/) (or Task Scheduler "at startup"), put IIS/Caddy in
front for TLS, and schedule `node scripts/backup.js` via Task Scheduler. The
app code is fully cross-platform.

## Pre-launch checklist

- [ ] `.env` set with `HOST=127.0.0.1`, `TRUST_PROXY=1`, your `ADMIN_USERNAMES`
- [ ] `systemctl status phantom-gallery` is active; `/healthz` returns ok
- [ ] HTTPS works; `http://` redirects to `https://`
- [ ] Port 8173 is **not** reachable from outside (`curl http://SERVER_IP:8173` from elsewhere fails)
- [ ] Backup timer enabled and a test snapshot exists
- [ ] `npm test` passes
- [ ] You can register, create a community, upload a photo end-to-end over HTTPS
