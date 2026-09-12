#!/usr/bin/env node
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";

const serveOnly = process.argv.includes("--serve");
const listenHost = process.env.PROXY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.PROXY_PORT ?? "5173");
const targetHost = process.env.TARGET_HOST ?? "127.0.0.1";
const targetPort = Number(process.env.TARGET_PORT ?? "3100");
const prefix = (process.env.APP_PREFIX ?? "/apps/pi-forge").replace(/\/$/, "");
const secret =
  process.env.DASHBOARD_IDENTITY_SECRET ?? "dev-dashboard-identity-secret-32-bytes-min";
const issuer = process.env.DASHBOARD_IDENTITY_ISSUER ?? "internal-dashboard";
const appId = process.env.DASHBOARD_APP_ID ?? "pi-forge";
const username = process.env.DASHBOARD_USER ?? "dev-user";
const email = process.env.DASHBOARD_EMAIL ?? "dev-user@example.test";
const groups = (process.env.DASHBOARD_GROUPS ?? "cn=devs,ou=groups,dc=example,dc=com")
  .split(";")
  .map((group) => group.trim())
  .filter(Boolean);

const stripHeaders = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-prefix",
  "x-real-ip",
  "x-dashboard-user",
  "x-dashboard-display-name",
  "x-dashboard-email",
  "x-dashboard-groups",
  "x-dashboard-app-id",
  "x-dashboard-identity",
  "x-dashboard-signature",
]);

function identityHeaders(req) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: appId,
    sub: username,
    email,
    groups,
    app: appId,
    iat: now,
    exp: now + 60,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");
  return {
    "x-dashboard-user": username,
    "x-dashboard-display-name": username,
    "x-dashboard-email": email,
    "x-dashboard-groups": JSON.stringify(groups),
    "x-dashboard-app-id": appId,
    "x-dashboard-identity": encoded,
    "x-dashboard-signature": signature,
    "x-forwarded-for": req.socket.remoteAddress ?? "127.0.0.1",
    "x-forwarded-host": req.headers.host ?? `127.0.0.1:${listenPort}`,
    "x-forwarded-proto": "http",
    "x-forwarded-prefix": prefix,
  };
}

function rewriteUrl(url) {
  if (url === prefix) return "/";
  if (url.startsWith(`${prefix}/`)) return url.slice(prefix.length) || "/";
  return undefined;
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  for (const header of stripHeaders) delete headers[header];
  headers.host = `${targetHost}:${targetPort}`;
  Object.assign(headers, identityHeaders(req));
  return headers;
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "") {
    res.writeHead(302, { Location: `${prefix}/` });
    res.end();
    return;
  }

  const rewritten = rewriteUrl(req.url ?? "/");
  if (rewritten === undefined) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`not proxied by dashboard simulator: ${req.url}\n`);
    return;
  }

  const upstream = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: rewritten,
      headers: proxyHeaders(req),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      const setCookie = headers["set-cookie"];
      if (setCookie) {
        headers["set-cookie"] = (Array.isArray(setCookie) ? setCookie : [setCookie]).map(
          (cookie) => {
            const noDomain = cookie.replace(/;\s*Domain=[^;]*/gi, "");
            return /;\s*Path=/i.test(noDomain)
              ? noDomain.replace(/;\s*Path=[^;]*/i, `; Path=${prefix}/`)
              : `${noDomain}; Path=${prefix}/`;
          },
        );
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message}\n`);
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const rewritten = rewriteUrl(req.url ?? "/");
  if (rewritten === undefined) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const upstream = net.connect(targetPort, targetHost, () => {
    const headers = proxyHeaders(req);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";
    const lines = [`${req.method} ${rewritten} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      const displayHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
      console.log(
        `[dashboard-proxy-smoke] http://${displayHost}:${listenPort}${prefix}/ -> http://${targetHost}:${targetPort}/`,
      );
      resolve();
    });
  });
}

async function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

async function smokeTest() {
  const base = `http://127.0.0.1:${listenPort}${prefix}`;
  const htmlRes = await fetch(`${base}/`);
  const html = await htmlRes.text();
  await assertOk(htmlRes.ok, `app shell returned ${htmlRes.status}`);
  await assertOk(
    html.includes(`name="pi-forge-base-path" content="${prefix}"`),
    "app shell is missing runtime base-path meta tag",
  );

  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  await assertOk(assetRefs.length > 0, "app shell did not reference built assets");
  await assertOk(
    assetRefs.every((ref) => ref.startsWith(`${prefix}/assets/`)),
    `asset refs were not runtime-prefixed: ${assetRefs.join(", ")}`,
  );

  for (const ref of assetRefs) {
    const res = await fetch(new URL(ref, base));
    const contentType = res.headers.get("content-type") ?? "";
    await assertOk(res.ok, `${ref} returned ${res.status}`);
    if (ref.endsWith(".js"))
      await assertOk(/javascript|ecmascript/.test(contentType), `${ref} returned ${contentType}`);
    if (ref.endsWith(".css"))
      await assertOk(contentType.includes("text/css"), `${ref} returned ${contentType}`);
  }

  const authStatus = await (await fetch(`${base}/api/v1/auth/status`)).json();
  await assertOk(
    authStatus.dashboardIdentityAuthenticated === true,
    "dashboard identity was not accepted",
  );

  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  await assertOk(
    manifest.start_url === `${prefix}/`,
    `manifest start_url was ${manifest.start_url}`,
  );
  await assertOk(manifest.scope === `${prefix}/`, `manifest scope was ${manifest.scope}`);

  console.log(
    `[dashboard-proxy-smoke] OK: runtime prefix ${prefix} assets, manifest, and SSO all passed`,
  );
}

await listen();
if (serveOnly) {
  console.log("[dashboard-proxy-smoke] --serve mode; press Ctrl+C to stop");
} else {
  try {
    await smokeTest();
  } finally {
    server.close();
  }
}
