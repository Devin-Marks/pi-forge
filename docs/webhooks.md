# Webhooks

HTTPS POST deliveries fired when interesting things happen on a
session or project. Configure from **Settings → Webhooks**.

> A webhook is one direction: pi-forge → your endpoint. If you
> want the opposite (your script reads agent events), use the SSE
> stream documented in [`sse-events.md`](./sse-events.md). The two
> systems are independent — disabling webhooks doesn't affect SSE.

## Events

Seven event types in v1:

| Event | When it fires |
|---|---|
| `agent_end` | An agent turn finished. Payload includes `stopReason`, `errorMessage` (if any), the assistant's text content, usage stats, and the provider/model used. |
| `ask_user_question` | The agent put up a multi-choice prompt via the `ask_user_question` tool and is waiting on a human answer. Payload includes the questions array. |
| `process_alert` | A background process the agent spawned via the `process` tool exited. Same trigger conditions as the in-chat agent alert — success / failure / external kill — see [`processes.md`](./processes.md). |
| `auto_retry_end` *(failures only)* | The SDK's auto-retry on a provider error exhausted. Useful for paging when an upstream LLM provider goes down. |
| `compaction_end` *(non-aborted only)* | Session context was compacted. Payload includes `tokensBefore` and the compaction reason. |
| `session_created` | A new session was created in a project. |
| `session_deleted` | A session was deleted (cold or live). Payload's `wasLive` distinguishes "we disposed a running session" from "we removed an on-disk-only JSONL." |

## Scoping

Each webhook is either:

- **Global** — fires for every project's events.
- **Per-project** — fires only for events whose `projectId`
  matches a single configured project.

Both can coexist. The UI shows global + per-project for the
currently selected project; switching project re-filters.

## Delivery, retry, and timeouts

- POST with `Content-Type: application/json`, body shape `{ event,
  sessionId?, projectId?, deliveryId, occurredAt, data }`.
- **2xx** — delivered. Done.
- **4xx** — terminal, no retry. The receiver said the payload was
  invalid; retrying with the same body won't change anything.
- **5xx or network error** — retried with exponential backoff:
  **1s, 5s, 30s** (3 attempts total). After the third failure the
  delivery is recorded as `failed` and the dispatcher moves on.
- Per-attempt timeout is 30 seconds.
- All dispatches are fire-and-forget from the event-bridge
  perspective — the bridge returns as soon as the per-target
  attempt is queued, retries run in the background.

## Security

### HTTPS-only

The URL must be `https://`. The route validates this; `http://`,
`ssh://`, file URLs all 400 with `unsupported_protocol`.

### HMAC-SHA256 signatures

Configure a **secret** on the webhook to get signed deliveries.
Every POST then carries:

```
X-Pi-Forge-Signature: sha256=<hex digest of the raw JSON body>
```

Convention matches GitHub's webhook signing. Verify on the
receiver side:

```python
import hmac, hashlib

def verify(secret: bytes, body: bytes, header: str) -> bool:
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)
```

Secrets are stored in `${FORGE_DATA_DIR}/webhooks.json` (mode
`0600`) and **never returned over the wire** — the API surfaces a
`hasSecret: boolean` flag instead of the value. Same posture as
`auth.json` provider keys.

### Self-signed / corporate CA endpoints

For internal webhook targets behind a private CA, set the
per-webhook **"Allow self-signed / invalid TLS certificate"**
checkbox. Every delivery for that webhook then uses an
`https.Agent({ rejectUnauthorized: false })` and writes a
`webhook-insecure-tls` line to stderr — so the relaxed posture
is visible in `docker logs`.

The flag **only** relaxes cert validation. The URL must still be
HTTPS; `insecureTls` won't accept `http://`.

### Custom headers (Bearer tokens, etc.)

Each webhook can carry a set of static request headers — typical
use is `Authorization: Bearer <token>` for receivers that need
their own auth. Headers are stored alongside the rest of the
config but treated as secret:

- **Header values are redacted on the wire.** `GET /webhooks` and
  `GET /webhooks/:id` return the header NAMES verbatim but
  replace every VALUE with the `***REDACTED***` sentinel — the
  same convention `config-manager.ts` uses for inline `apiKey` in
  `models.json`. The wire never carries the real value.
- **Editing in the UI preserves stored values.** When the client
  PATCHes back a header value that's literally the sentinel, the
  server treats it as "keep the existing value." Typing a new
  value replaces; deleting the field clears the header.
- **CREATE rejects the sentinel** as a real value — no prior to
  keep on a fresh create.
- **Defense-in-depth at dispatch time**: if the sentinel ever
  ends up in the stored config (hand-edit, future bug), the
  dispatcher skips it at outbound-POST time so the receiver
  never sees `Authorization: ***REDACTED***`.

### Reserved headers

The following headers are set by pi-forge on every delivery and
**cannot** be overridden by config:

- `Content-Type` (always `application/json`)
- `X-Pi-Forge-Event` (event name)
- `X-Pi-Forge-Delivery` (UUID for this attempt)
- `X-Pi-Forge-Signature` (HMAC if a secret is configured)
- `User-Agent` (pi-forge version)

A configured header with one of these names is silently dropped.

## Delivery history

Every attempt (success or failure) is appended to
`${FORGE_DATA_DIR}/webhook-deliveries.json`, capped at **100 per
webhook** (rolling FIFO). Surfaced in **Settings → Webhooks** under
the per-webhook drawer, and via `GET /webhooks/:id/deliveries`.

Use it to debug a stuck receiver — `errorPreview` on failed
attempts shows the first 200 chars of the response body.

## MINIMAL_UI

Webhook configuration is **disabled under `MINIMAL_UI=true`**: the
Settings tab is hidden, and `POST` / `PATCH` / `DELETE` /
`/test` routes return `403 minimal_ui_disabled`. The `GET` routes
stay available so an operator can still audit what's wired up,
and event delivery for already-configured webhooks still fires.

The rationale: webhooks let the server make arbitrary HTTPS calls
to user-supplied URLs. Under MINIMAL_UI (locked-down deploys),
only the operator should configure that — via direct file edits
to `${FORGE_DATA_DIR}/webhooks.json` or via env-driven config
management.

## Storage

| File | Purpose | Mode |
|---|---|---|
| `webhooks.json` | Webhook configs (URLs, events, scope, secrets, headers, TLS flag) | `0600` — contains HMAC secrets |
| `webhook-deliveries.json` | Rolling delivery history (cap 100 / webhook) | `0600` |

Atomic-write + in-process lock pattern (see `project-manager.ts`
for the same posture). Single-tenant / single-process assumption
— cross-process safety would need a real file lock.

## REST surface

| Method + path | Purpose |
|---|---|
| `GET /api/v1/webhooks[?projectId=…]` | List webhooks. Optional filter returns global ∪ per-project for one project. |
| `POST /api/v1/webhooks` | Create. Validates HTTPS-only URL, non-empty event subscription, known event types. |
| `PATCH /api/v1/webhooks/:id` | Partial update. Sentinel-in-header semantics described above. |
| `DELETE /api/v1/webhooks/:id` | Delete + prune deliveries. |
| `POST /api/v1/webhooks/:id/test` | Fire a synthetic `webhook.test` event at the target, bypassing the event/scope filter — useful for verifying URL + signature wiring before waiting for a real event. |
| `GET /api/v1/webhooks/:id/deliveries` | Recent attempts (newest first), capped at 100 per webhook. |

Mutation routes are gated by MINIMAL_UI; the `GET` routes are not.

Full schemas at `/api/docs`.

## Receiver examples

### Python (FastAPI)

```python
import hmac, hashlib, os
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
SECRET = os.environ["WEBHOOK_SECRET"].encode()

@app.post("/pi-forge")
async def receive(
    request: Request,
    x_pi_forge_signature: str | None = Header(None),
    x_pi_forge_event: str | None = Header(None),
):
    body = await request.body()
    if x_pi_forge_signature is None:
        raise HTTPException(401, "missing signature")
    expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_pi_forge_signature):
        raise HTTPException(401, "bad signature")
    payload = await request.json()
    # …handle by payload["event"] ...
    return {"ok": True}
```

### Node (Express)

```js
import express from "express";
import crypto from "node:crypto";

const app = express();
const SECRET = process.env.WEBHOOK_SECRET;

app.post("/pi-forge", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.get("X-Pi-Forge-Signature");
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET)
    .update(req.body).digest("hex");
  if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).end("bad signature");
  }
  const payload = JSON.parse(req.body.toString());
  // …handle by payload.event ...
  res.json({ ok: true });
});
```

## Troubleshooting

**Deliveries show `failed` with no detail.** Check the receiver's
TLS chain — pi-forge requires a valid cert by default. If the
target is internal with a self-signed cert or a private CA, flip
the per-webhook **Allow self-signed / invalid TLS certificate**
checkbox.

**`unsupported_protocol` on CREATE.** The URL must be HTTPS.
Pi-forge intentionally refuses plain HTTP even when `insecureTls`
is set — the flag relaxes cert validation, not the scheme.

**The test event arrives but real events don't.** Check the
event subscription on the webhook (`events` array) and the
scope. A per-project webhook only fires for events whose
`projectId` matches.

**Header value lost after editing.** If you PATCHed without
including the headers field at all, the server leaves stored
headers alone (the route can't distinguish "omitted" from
"cleared" in JSON). If you PATCHed with the field present but a
value set to the literal `***REDACTED***` sentinel, that
specifically means "keep the existing value" — typing a new
value replaces it.

**MINIMAL_UI disable surprised me.** The Webhooks Settings tab
hides under MINIMAL_UI and POST/PATCH/DELETE routes 403. Already-
configured webhooks still fire — disable applies only to config
changes. To reach the config under MINIMAL_UI, edit
`${FORGE_DATA_DIR}/webhooks.json` directly (mode `0600`) and
restart.

## See also

- [`orchestration.md`](./orchestration.md) — the in-app equivalent
  of webhook fan-out. Orchestration routes worker events back to
  a supervisor session's inbox; webhooks route them out over
  HTTPS. Same underlying event bridge feeds both.
- [`sse-events.md`](./sse-events.md) — the streaming-pull
  alternative for real-time consumers.
- [`processes.md`](./processes.md) — what triggers `process_alert`.
- [`ask-user-question.md`](./ask-user-question.md) — what triggers
  `ask_user_question`.
- [`CLAUDE.md`](../CLAUDE.md) — file-by-file map of the
  `packages/server/src/webhooks/` module.
