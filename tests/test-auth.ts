/**
 * Phase 2 auth integration test.
 *
 * Spawns the compiled server in three configurations:
 *   A) UI_PASSWORD set, JWT_SECRET set, no API_KEY  → password+JWT path
 *   B) API_KEY set, no UI_PASSWORD                  → API-key-only path
 *   C) Neither set                                  → auth fully disabled
 *
 * Asserts the matrix of expected status codes plus a deterministic rate-limit
 * check (RATE_LIMIT_LOGIN_MAX=3 → 4th login attempt returns 429).
 *
 * Note: there are no protected /api/v1/* routes yet (sessions etc. land in
 * Phase 4+). To exercise the preHandler we hit /api/v1/__protected_probe — a
 * path that does not exist BUT still passes through the preHandler. The
 * preHandler runs first; if it rejects we get 401 from the hook, otherwise we
 * get 404 from Fastify's not-found handler. Both responses prove the
 * preHandler is doing its job.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(new Error("failed to acquire free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolveFn(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timeout waiting for ${url}`);
}

interface RunningServer {
  port: number;
  child: ChildProcess;
  base: string;
  stop: () => Promise<void>;
}

async function startServer(env: Record<string, string | undefined>): Promise<RunningServer> {
  const port = await pickFreePort();
  // Force per-spawn isolation of the data dir. The default
  // (~/.pi-forge) leaks any password-hash / jwt-secret / projects.json
  // the developer has on their actual machine into the test, which
  // breaks the "auth disabled" / "API_KEY only" scenarios — they
  // assume no on-disk hash exists, but `authEnabled()` reads
  // existsSync(passwordHashFile) and returns true even when neither
  // env var is set. mkdtemp gives each spawn a clean slate; the
  // cleanup runs in stop().
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-test-auth-"));
  const workspacePath = join(dataDir, "workspace");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      FORGE_DATA_DIR: dataDir,
      WORKSPACE_PATH: workspacePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      });
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await waitFor(`${base}/api/v1/health`);
  } catch (err) {
    await stop();
    throw err;
  }
  return { port, child, base, stop };
}

async function jsonPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function scenarioPasswordAndJwt(): Promise<void> {
  console.log("\n[scenario A] UI_PASSWORD + JWT_SECRET (no API_KEY)");
  const password = "hunter2";
  const jwtSecret = randomBytes(32).toString("hex");
  const srv = await startServer({
    UI_PASSWORD: password,
    JWT_SECRET: jwtSecret,
    API_KEY: undefined,
    RATE_LIMIT_LOGIN_MAX: "3",
    RATE_LIMIT_LOGIN_WINDOW_MS: "60000",
    // Pinned explicitly even though `false` is now the default — keeps
    // this scenario's intent visible (we want a *normal* JWT, not the
    // change-password-scoped initial-login token). The change-password
    // flow is its own concern and isn't exercised here.
    REQUIRE_PASSWORD_CHANGE: "false",
  });
  try {
    const status = await fetch(`${srv.base}/api/v1/auth/status`);
    assert("auth/status returns 200", status.status === 200);
    const statusBody = (await status.json()) as { authEnabled: boolean };
    assert("auth/status reports authEnabled=true", statusBody.authEnabled === true);

    const wrong = await jsonPost(`${srv.base}/api/v1/auth/login`, { password: "wrong" });
    assert("login with wrong password → 401", wrong.status === 401);

    const right = await jsonPost(`${srv.base}/api/v1/auth/login`, { password });
    assert("login with correct password → 200", right.status === 200);
    const issued = (await right.json()) as { token: string; expiresAt: string };
    assert(
      "issued.token is non-empty",
      typeof issued.token === "string" && issued.token.length > 0,
    );
    assert(
      "issued.expiresAt is in the future",
      typeof issued.expiresAt === "string" && new Date(issued.expiresAt).getTime() > Date.now(),
    );

    const probeNoToken = await fetch(`${srv.base}/api/v1/__protected_probe`);
    assert("protected probe with no token → 401", probeNoToken.status === 401);

    const probeWithJwt = await fetch(`${srv.base}/api/v1/__protected_probe`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert(
      "protected probe with valid JWT → 404 (passes auth, falls to not-found)",
      probeWithJwt.status === 404,
    );

    const probeBadToken = await fetch(`${srv.base}/api/v1/__protected_probe`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert("protected probe with garbage token → 401", probeBadToken.status === 401);

    // Rate limit: max=3, window=60s. We've used 2 attempts so far (1 wrong + 1
    // right). Attempt #3 should still go through; attempt #4 should be 429.
    const wrong2 = await jsonPost(`${srv.base}/api/v1/auth/login`, { password: "x" });
    assert("login attempt 3 in window → 401 (still allowed)", wrong2.status === 401);
    const wrong3 = await jsonPost(`${srv.base}/api/v1/auth/login`, { password: "x" });
    assert("login attempt 4 in window → 429 rate-limited", wrong3.status === 429);
  } finally {
    await srv.stop();
  }
}

async function scenarioApiKeyOnly(): Promise<void> {
  console.log("\n[scenario B] API_KEY only (no UI_PASSWORD)");
  const apiKey = "test-api-key-" + randomBytes(8).toString("hex");
  const srv = await startServer({
    UI_PASSWORD: undefined,
    JWT_SECRET: undefined,
    API_KEY: apiKey,
  });
  try {
    const status = (await (await fetch(`${srv.base}/api/v1/auth/status`)).json()) as {
      authEnabled: boolean;
    };
    assert("auth/status reports authEnabled=true (api-key only)", status.authEnabled === true);

    // Login route should be 503 because UI_PASSWORD is unset.
    const login = await jsonPost(`${srv.base}/api/v1/auth/login`, { password: "anything" });
    assert("login → 503 when UI_PASSWORD is unset", login.status === 503);

    const probeNoToken = await fetch(`${srv.base}/api/v1/__protected_probe`);
    assert("protected probe with no token → 401", probeNoToken.status === 401);

    const probeWithKey = await fetch(`${srv.base}/api/v1/__protected_probe`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert("protected probe with valid API key → 404 (passes auth)", probeWithKey.status === 404);

    const probeWithBadKey = await fetch(`${srv.base}/api/v1/__protected_probe`, {
      headers: { Authorization: `Bearer wrong-key` },
    });
    assert("protected probe with wrong API key → 401", probeWithBadKey.status === 401);
  } finally {
    await srv.stop();
  }
}

async function scenarioAuthDisabled(): Promise<void> {
  console.log("\n[scenario C] auth disabled (neither set)");
  const srv = await startServer({
    UI_PASSWORD: undefined,
    JWT_SECRET: undefined,
    API_KEY: undefined,
  });
  try {
    const status = (await (await fetch(`${srv.base}/api/v1/auth/status`)).json()) as {
      authEnabled: boolean;
    };
    assert("auth/status reports authEnabled=false", status.authEnabled === false);

    const probeNoToken = await fetch(`${srv.base}/api/v1/__protected_probe`);
    assert(
      "protected probe with no token → 404 (auth bypassed, falls to not-found)",
      probeNoToken.status === 404,
    );
  } finally {
    await srv.stop();
  }
}

async function main(): Promise<void> {
  await scenarioPasswordAndJwt();
  await scenarioApiKeyOnly();
  await scenarioAuthDisabled();

  if (failures > 0) {
    console.log(`\n[test-auth] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-auth] PASS");
}

main().catch((err) => {
  console.error("[test-auth] uncaught error:", err);
  process.exit(1);
});
