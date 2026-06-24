import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

async function waitFor(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // keep trying until the server is ready
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (address === null || typeof address === "string") throw new Error("unexpected listen address");
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    child.once("exit", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1500).unref();
  });
}

function serveLogo(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/logo.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    );
    return;
  }
  if (req.url === "/not-an-image") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not an image");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function main(): Promise<void> {
  const viteConfig = await readFile(resolve(repoRoot, "packages/client/vite.config.ts"), "utf8");
  assert("Vite dev server proxies cached logo URLs", viteConfig.includes('"/cache"'));

  const remote = createServer(serveLogo);
  await new Promise<void>((resolveListen) => remote.listen(0, "127.0.0.1", resolveListen));
  const address = remote.address();
  if (address === null || typeof address === "string") throw new Error("unexpected listen address");
  const remoteBase = `http://127.0.0.1:${address.port}`;

  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-logo-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-logo-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-logo-data-"));

  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  process.env.AUTH_URL_LOGO = `${remoteBase}/logo.svg`;
  process.env.APP_LOGO_DARK_URL = `${remoteBase}/not-an-image`;
  process.env.APP_LOGO_LIGHT_URL = `${remoteBase}/missing.svg`;
  delete process.env.AUTH_LOGO_URL;
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  const buildModule = (await import(resolve(repoRoot, "packages/server/dist/index.js"))) as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    const cfgRes = await fetch(`${base}/api/v1/ui-config`);
    const cfg = (await cfgRes.json()) as {
      logoUrlMode?: string;
      authLogoUrl?: string;
      appLogoDarkUrl?: string;
      appLogoLightUrl?: string;
    };
    assert(
      "ui-config reports default cache mode",
      cfg.logoUrlMode === "cache",
      JSON.stringify(cfg),
    );
    assert(
      "ui-config returns cached auth logo",
      cfg.authLogoUrl?.startsWith("/cache/logos/auth-") === true,
      JSON.stringify(cfg),
    );
    assert(
      "invalid dark logo falls back to built-in",
      cfg.appLogoDarkUrl === undefined,
      JSON.stringify(cfg),
    );
    assert(
      "missing light logo falls back to built-in",
      cfg.appLogoLightUrl === undefined,
      JSON.stringify(cfg),
    );

    const defaultCsp = cfgRes.headers.get("content-security-policy") ?? "";
    assert(
      "cache mode CSP keeps img-src same-origin",
      defaultCsp.includes("img-src 'self' data: blob:"),
    );
    assert("cache mode CSP does not allow remote logo origin", !defaultCsp.includes(remoteBase));

    const cachedRes = await fetch(`${base}${cfg.authLogoUrl}`);
    const cachedText = await cachedRes.text();
    assert("cached logo is served same-origin", cachedRes.status === 200, String(cachedRes.status));
    assert("cached logo preserves SVG content", cachedText.includes("<svg"), cachedText);
  } finally {
    await fastify.close();
    await new Promise<void>((resolveClose) => remote.close(() => resolveClose()));
    await Promise.all([
      rm(workspacePath, { recursive: true, force: true }),
      rm(configDir, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  }

  const directWorkspace = await mkdtemp(join(tmpdir(), "pi-forge-logo-direct-ws-"));
  const directConfigDir = await mkdtemp(join(tmpdir(), "pi-forge-logo-direct-cfg-"));
  const directDataDir = await mkdtemp(join(tmpdir(), "pi-forge-logo-direct-data-"));
  const directPort = await pickFreePort();
  const directChild = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(directPort),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      WORKSPACE_PATH: directWorkspace,
      PI_CONFIG_DIR: directConfigDir,
      FORGE_DATA_DIR: directDataDir,
      SESSION_DIR: join(directWorkspace, ".pi", "sessions"),
      LOGO_URL_MODE: "direct",
      LOGO_IMG_SRC_ALLOWLIST: "https://cdn.example.org",
      AUTH_URL_LOGO: `${remoteBase}/logo.svg`,
      APP_LOGO_DARK_URL: `${remoteBase}/not-an-image`,
      APP_LOGO_LIGHT_URL: `${remoteBase}/missing.svg`,
      AUTH_LOGO_URL: undefined,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      API_KEY: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  directChild.stderr?.on("data", (b) =>
    process.stderr.write(`[direct server stderr] ${String(b)}`),
  );
  const directBase = `http://127.0.0.1:${directPort}`;

  try {
    await waitFor(`${directBase}/api/v1/health`);
    const cfgRes = await fetch(`${directBase}/api/v1/ui-config`);
    const cfg = (await cfgRes.json()) as {
      logoUrlMode?: string;
      authLogoUrl?: string;
      appLogoDarkUrl?: string;
      appLogoLightUrl?: string;
    };
    assert("direct mode is reported", cfg.logoUrlMode === "direct", JSON.stringify(cfg));
    assert("direct mode returns raw auth URL", cfg.authLogoUrl === `${remoteBase}/logo.svg`);
    assert(
      "direct mode returns raw dark URL without server validation",
      cfg.appLogoDarkUrl === `${remoteBase}/not-an-image`,
    );
    assert(
      "direct mode returns raw light URL without server validation",
      cfg.appLogoLightUrl === `${remoteBase}/missing.svg`,
    );

    const csp = cfgRes.headers.get("content-security-policy") ?? "";
    assert("direct mode CSP allows configured logo origin", csp.includes(remoteBase), csp);
    assert(
      "direct mode CSP includes extra allowlist origin",
      csp.includes("https://cdn.example.org"),
      csp,
    );
    assert(
      "direct mode does not register cache route",
      (await fetch(`${directBase}/cache/logos/nope.svg`)).status === 404,
    );
  } finally {
    await stopChild(directChild);
    await Promise.all([
      rm(directWorkspace, { recursive: true, force: true }),
      rm(directConfigDir, { recursive: true, force: true }),
      rm(directDataDir, { recursive: true, force: true }),
    ]);
  }

  const invalidMode = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import ${JSON.stringify(pathToFileURL(resolve(repoRoot, "packages/server/dist/config.js")).href)}`,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        WORKSPACE_PATH: await mkdtemp(join(tmpdir(), "pi-forge-logo-invalid-ws-")),
        PI_CONFIG_DIR: await mkdtemp(join(tmpdir(), "pi-forge-logo-invalid-cfg-")),
        FORGE_DATA_DIR: await mkdtemp(join(tmpdir(), "pi-forge-logo-invalid-data-")),
        NODE_ENV: "test",
        LOGO_URL_MODE: "bogus",
        UI_PASSWORD: undefined,
        JWT_SECRET: undefined,
        API_KEY: undefined,
      },
      encoding: "utf8",
    },
  );
  assert(
    "invalid LOGO_URL_MODE fails config parsing",
    invalidMode.status !== 0,
    invalidMode.stderr,
  );
  assert(
    "invalid LOGO_URL_MODE error names accepted values",
    invalidMode.stderr.includes("cache, direct"),
    invalidMode.stderr,
  );

  if (failures > 0) process.exit(1);
  console.log("\nPASS  test-logo-cache");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
