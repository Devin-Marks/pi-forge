# Deployment

Running pi-forge for use on a **private network** — your homelab, an
office LAN, an internal VLAN, an air-gapped subnet. Reverse-proxy
config (single hostname, optional TLS for PWA install), auth, and
env-var guidance.

> Pi-forge is **not designed for public-internet exposure.** The
> agent's `bash` tool is a real shell with the container's
> permissions; the integrated terminal is a live PTY. Even with auth
> on, the right deployment shape is "trusted users on a trusted
> network." For multi-tenant or hostile-network use cases, pi-forge
> is the wrong tool.

For the container itself see [`containers.md`](./containers.md); for
Kubernetes / OpenShift see
[`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md).

## Before you deploy

- [ ] **Set `UI_PASSWORD` or `API_KEY` (or both)** before binding to
      anything other than loopback. Even on a trusted LAN, passing
      credentials prevents a sibling device from poking at the API
      by accident.
- [ ] **`TRUST_PROXY=true`** if there's a reverse proxy in front, so
      the login rate-limit sees real client IPs instead of the
      proxy's IP.
- [ ] **`CORS_ORIGIN` pinned** to the hostname you'll reach pi-forge
      at (e.g. `http://pi-forge.local:3000` or
      `https://pi-forge.internal.lan`). Defaults to reflecting any
      origin — fine for solo loopback use, worth pinning when other
      devices on the LAN can reach it.
- [ ] **Workspace, pi config, and forge data on backed-up storage.**
      The container is replaceable; sessions + provider keys aren't.
- [ ] **Provider account has a spending limit set.** Pi-forge surfaces
      cost telemetry but doesn't enforce caps.

`JWT_SECRET` is auto-generated and persisted to
`${FORGE_DATA_DIR}/jwt-secret` (mode 0600) on first boot. Set
explicitly only if you want to manage rotation out-of-band; delete
the file to rotate in-place.

## Recommended topologies

### Loopback only (single user on the host)

Default. Container binds to `127.0.0.1:3000`. Nothing else on the
network can reach it. No reverse proxy, no TLS, no auth required.

### LAN access via direct port-forward

Container binds to `0.0.0.0:3000` (e.g. drop the `127.0.0.1:` prefix
in `docker/docker-compose.yml`). Set `UI_PASSWORD` or `API_KEY`
before exposing — anything on the LAN can hit `http://<host>:3000`.

### LAN access behind a reverse proxy (recommended for multi-device use)

```
Browser on phone / laptop / etc.
        │
        ▼  HTTP(S) on the LAN
   reverse proxy (Caddy / nginx / Traefik on the same host or a
   sibling host) — single hostname, optional TLS for PWA install
        │
        ▼  HTTP, loopback
   pi-forge container on 127.0.0.1:3000
```

The proxy gives you:

- **A stable hostname** — `http://pi-forge.local` instead of
  `http://10.0.0.42:3000`
- **Optional TLS** — a PWA install on iOS / Android requires HTTPS,
  even on a LAN. Use [mkcert](https://github.com/FiloSottile/mkcert)
  or your internal CA. Caddy's `tls internal` directive will also
  generate certs from its own local CA
- **A single bind point** for multiple deploys on one host (see
  Multi-deploy patterns below)

## Reverse-proxy snippets

Examples use `pi-forge.local` (mDNS) — substitute whatever hostname
the LAN's DNS / `/etc/hosts` resolves. The recurring requirements:
forward `X-Forwarded-*`, support WebSocket upgrade, disable response
buffering for SSE, and lift the proxy's read timeout to handle long
agent runs (30 min is a reasonable ceiling).

### Caddy

```caddy
pi-forge.local {
    reverse_proxy localhost:3000 {
        flush_interval -1            # don't buffer SSE
        transport http {
            read_timeout 30m         # long agent runs
        }
    }
}
```

Reload: `caddy reload --config /etc/caddy/Caddyfile`. Caddy will try
to auto-provision TLS for the hostname; on a LAN-only deploy use
`tls internal` (Caddy's built-in CA) or supply a cert from your own
CA / mkcert.

### nginx

```nginx
server {
    listen 80;
    server_name pi-forge.local;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Forwarded headers (TRUST_PROXY=true reads these)
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade (terminal route)
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $http_connection;

        # SSE + long agent runs
        proxy_buffering    off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        client_max_body_size 100M;
    }
}

map $http_upgrade $http_connection { default upgrade; "" ""; }
```

For HTTPS, add a `listen 443 ssl http2;` block with `ssl_certificate` /
`ssl_certificate_key` pointing at certs from your internal CA or
mkcert. Same `location` block contents.

### Traefik (Docker labels)

```yaml
services:
  pi-forge:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.pi-forge.rule=Host(`pi-forge.local`)"
      - "traefik.http.routers.pi-forge.entrypoints=web"
      - "traefik.http.services.pi-forge.loadbalancer.server.port=3000"
```

In Traefik's static config, lift
`entryPoints.web.transport.respondingTimeouts.readTimeout` to
`3600s` so SSE streams aren't terminated at the default 60 s.
WebSocket upgrades are handled transparently.

## Network-deploy env-var overrides

Full reference: [`configuration.md`](./configuration.md#environment-variables).
Values to override defaults when other devices on the LAN can reach
pi-forge:

| Variable | Value | Why |
|---|---|---|
| `TRUST_PROXY` | `true` | Required when behind a reverse proxy so the login rate-limit sees real client IPs |
| `CORS_ORIGIN` | the URL you reach pi-forge at, e.g. `http://pi-forge.local:3000` | Pinning stops other LAN origins from making cross-origin requests with the user's credentials |
| `JWT_EXPIRES_IN_SECONDS` | `86400` (24 h) for shared-LAN deploys; default `604800` (7 d) for single-user | Shorter = smaller blast radius if a token leaks |
| `RATE_LIMIT_LOGIN_MAX` | default `10` is fine | Per-IP login attempts per minute |
| `LOG_LEVEL` | `info` (default) or `warn` if noisy | `debug` / `trace` are useful during incidents |
| `MINIMAL_UI` | `true` to hide terminal / git / settings from non-admin users | Frontend gate; server routes unchanged |

For multiple users on the same host, run separate pi-forge instances
(single-tenant by design) — see "Multi-deploy patterns" below.

### Auth setup

Pick one shape based on who needs access:

```bash
# Browser only
UI_PASSWORD=your-strong-password
API_KEY=

# API only (headless / scripts)
UI_PASSWORD=
API_KEY=$(openssl rand -hex 32)

# Both — humans + scripts share the deploy
UI_PASSWORD=your-strong-password
API_KEY=$(openssl rand -hex 32)
```

`JWT_SECRET` is empty in all three — the server auto-generates and
persists it to `${FORGE_DATA_DIR}/jwt-secret`. Override only if
managing rotation out-of-band (e.g. centrally rotated K8s `Secret`).

## Backups

Back up these three host paths:

1. **`${WORKSPACE_HOST_PATH}`** — your code + session JSONLs (under
   `.pi/sessions/`). Treat sessions as sensitive — they contain
   everything the agent saw.
2. **`${PI_CONFIG_HOST_PATH}`** — provider API keys + custom provider
   definitions. Encrypted at rest if your tooling supports it.
3. **`${FORGE_DATA_HOST_PATH}`** — `projects.json`, MCP / overrides
   files, `jwt-secret`, `password-hash`. Smallest of the three but
   loses your project list + invalidates browser sessions if dropped.

## Update / rollback

See [`containers.md`](./containers.md#updating). Bind-mounted state
(workspace, sessions, configs) survives rebuilds. The only state lost
is in-memory — SSE clients reconnect with backoff; PTYs are replaced
with fresh shells on the next attach.

## Multi-deploy patterns

pi-forge is single-tenant. To support multiple users, run multiple
deploys:

```yaml
# docker-compose.yml — one service per user
services:
  pi-forge-alice:
    container_name: pi-forge-alice
    image: pi-forge:latest
    ports: ["127.0.0.1:3001:3000"]
    volumes:
      - /srv/alice/workspace:/workspace
      - /srv/alice/.pi/agent:/home/pi/.pi/agent
      - /srv/alice/.pi-forge:/home/pi/.pi-forge
    environment:
      - UI_PASSWORD=${ALICE_PASSWORD}
      - JWT_SECRET=${ALICE_JWT_SECRET}
      - TRUST_PROXY=true

  pi-forge-bob:
    container_name: pi-forge-bob
    image: pi-forge:latest
    ports: ["127.0.0.1:3002:3000"]
    volumes:
      - /srv/bob/workspace:/workspace
      - /srv/bob/.pi/agent:/home/pi/.pi/agent
      - /srv/bob/.pi-forge:/home/pi/.pi-forge
    environment:
      - UI_PASSWORD=${BOB_PASSWORD}
      - JWT_SECRET=${BOB_JWT_SECRET}
      - TRUST_PROXY=true
```

Then route each via the proxy:

```caddy
alice.pi-forge.local {
    reverse_proxy localhost:3001 { flush_interval -1; transport http { read_timeout 30m } }
}
bob.pi-forge.local {
    reverse_proxy localhost:3002 { flush_interval -1; transport http { read_timeout 30m } }
}
```

Each deploy has its own JWT secret, its own provider keys, its own
projects, its own session history. Zero shared state.

## Monitoring

The shipped health endpoint is enough for liveness probes:

```bash
curl -s http://localhost:3000/api/v1/health
# { "status": "ok", "activeSessions": 0, "activePtys": 0 }
```

The container's `HEALTHCHECK` directive uses this (see
[`docs/containers.md`](./containers.md#health-check)).

For deeper observability, pi-forge logs to stdout in pino's JSON
format. Pipe through your log aggregator of choice:

```bash
# Promtail / Loki
docker compose logs -f pi-forge | promtail-pipe

# Vector
docker logs -f pi-forge | vector-pipe

# Just file rotation
docker compose logs -f pi-forge >> /var/log/pi-forge.log
```

Useful log fields to alert on:

- Repeated `terminal exited` with non-zero `exitCode` — agent's bash
  failing or shell crashing
- `pty spawn failed` — node-pty native binding broken (rare in container,
  common on host installs)
- `set model failed` — provider API rejecting requests (auth, quota)
- `unmapped file-manager error` — defensive log; investigate as a
  potential undocumented error path

There is no built-in metrics endpoint (no Prometheus exporter). The
session count and active PTY count from `/api/v1/health` are the only
exported numbers; scrape them with a 30 s job and alert on stuck values
if you care.

## See also

- [`docs/containers.md`](./containers.md) — Docker image internals,
  resources, troubleshooting
- [`docs/configuration.md`](./configuration.md) — pi config files
  (auth, models, settings) + custom providers
- [`docs/architecture.md`](./architecture.md) — component map, request
  lifecycles
- [`SECURITY.md`](../SECURITY.md) — full threat model + vulnerability
  reporting
- [`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md) — Kubernetes /
  OpenShift recipes
