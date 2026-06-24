import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
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
      authLogoUrl?: string;
      appLogoDarkUrl?: string;
      appLogoLightUrl?: string;
    };
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

  if (failures > 0) process.exit(1);
  console.log("\nPASS  test-logo-cache");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
