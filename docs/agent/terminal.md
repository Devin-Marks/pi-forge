# Agent Notes: Terminal

Read this when changing integrated terminal routes, PTY lifecycle, WebSocket auth/reattach behavior, resize handling, idle reap, or node-pty packaging.

## Terminal (Phase 11)

The integrated terminal uses `node-pty` on the server and `xterm.js` on the client,
connected over a WebSocket (not SSE — terminals need bidirectional communication).

- One PTY per terminal tab, spawned with `cwd` set to the project path
- Default shell: `process.env.SHELL || '/bin/sh'`
- When `AGENT_TOOL_SANDBOX_ENABLED=true`, `pty-manager.ts` passes `uid`/`gid`
  to `node-pty.spawn()` so terminals run as the restricted tool identity with
  the scrubbed terminal env, not as the root/server identity. It also rewrites
  `HOME` to `AGENT_TOOL_HOME` (Docker default: `/home/pi-tools`) so sandboxed
  CLIs can create their own config without writing the server user's home.
- WebSocket endpoint: `ws://localhost:3000/api/v1/terminal?projectId=<id>&tabId=<optional>&token=<jwt-or-api-key>`
  - `projectId` is required; `tabId` is the stable client-side tab identifier used for reattach across reconnects; `token` is required when auth is enabled (browsers can't attach `Authorization` headers on WebSocket upgrades).
- Fastify WebSocket support via `@fastify/websocket`
- PTY resize messages sent from client to server when the xterm container resizes
- On client disconnect, the PTY is **detached** and kept alive briefly so an immediate reconnect with the same `tabId` can reattach without losing scrollback. The PTY is killed only after the detach grace window or on explicit close — `pty-manager.ts` owns the lifecycle.
- Do NOT share PTY instances across clients or sessions — one PTY per `tabId`, one active WebSocket per PTY at a time.

---
