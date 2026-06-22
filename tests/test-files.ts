/**
 * Phase 10 file-browser/editor backend integration test.
 *
 * Boots the server in-process under a temp WORKSPACE_PATH + a synthesised
 * project, then drives every /files route through the auth gate. No LLM
 * required.
 *
 * Coverage:
 *   - GET /files/tree skips node_modules / .git / dist / __pycache__
 *   - PUT /files/write creates a file (with parent dirs); content reads back
 *     verbatim via GET /files/read; language detected from extension
 *   - POST /files/rename moves a file to a new basename in the same dir
 *   - POST /files/move relocates across directories
 *   - DELETE /files/delete removes a file
 *   - POST /files/mkdir creates a directory; second call → 409 (target_exists)
 *   - DELETE /files/delete on a non-empty dir → 409 (directory_not_empty)
 *   - DELETE /files/delete on an empty dir → 204
 *   - Path traversal: GET /files/read?path=../../etc/passwd → 403
 *   - Outside-project write → 403
 *   - Reading a binary file returns binary:true with empty content
 *   - 5 MB cap enforced (synthesised oversized file → 413)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile as fsRead,
  rm,
  symlink,
  writeFile as fsWrite,
} from "node:fs/promises";
import { createServer } from "node:net";
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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
  truncated?: boolean;
}

function flattenTree(node: TreeNode): string[] {
  const out: string[] = [];
  const visit = (n: TreeNode): void => {
    out.push(`${n.type}:${n.path}`);
    n.children?.forEach(visit);
  };
  visit(node);
  return out;
}

function findTreeNode(node: TreeNode, path: string): TreeNode | undefined {
  if (node.path.replaceAll("\\", "/") === path) return node;
  for (const child of node.children ?? []) {
    const found = findTreeNode(child, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });
  // Seed a project tree with the noisy dirs the route should skip.
  await mkdir(join(projectPath, "src"), { recursive: true });
  await mkdir(join(projectPath, "src", "deep"), { recursive: true });
  const deepVisibleDir = join(projectPath, "d1", "d2", "d3", "d4", "d5", "d6", "d7");
  await mkdir(deepVisibleDir, { recursive: true });
  const cappedParts = Array.from({ length: 33 }, (_, i) => `cap${i + 1}`);
  const cappedDir = join(projectPath, ...cappedParts);
  await mkdir(cappedDir, { recursive: true });
  await mkdir(join(projectPath, "node_modules", "fake-pkg"), { recursive: true });
  await mkdir(join(projectPath, ".git", "objects"), { recursive: true });
  await mkdir(join(projectPath, "dist"), { recursive: true });
  await fsWrite(join(projectPath, "src", "index.ts"), "export const x = 1;\n", "utf8");
  await fsWrite(join(projectPath, "src", "deep", "nested.txt"), "deep content\n", "utf8");
  await fsWrite(join(deepVisibleDir, "leaf.txt"), "visible deep leaf\n", "utf8");
  await fsWrite(join(cappedDir, "leaf.txt"), "capped leaf\n", "utf8");
  await symlink(join("src", "index.ts"), join(projectPath, "linked-index.ts"));
  await fsWrite(join(projectPath, "node_modules", "fake-pkg", "index.js"), "module.exports={};\n");
  await fsWrite(join(projectPath, ".git", "HEAD"), "ref: refs/heads/main\n");
  // A binary fixture (NUL-byte triggers binary detection).
  const bin = Buffer.concat([Buffer.from("PNG\0"), Buffer.alloc(16)]);
  await fsWrite(join(projectPath, "logo.png"), bin);

  const apiKey = "test-api-key-" + randomBytes(8).toString("hex");
  const port = await pickFreePort();

  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      WORKSPACE_PATH: workspacePath,
      PI_CONFIG_DIR: configDir,
      FORGE_DATA_DIR: dataDir,
      SESSION_DIR: join(workspacePath, ".pi", "sessions"),
      API_KEY: apiKey,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      SERVE_CLIENT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    });
  };

  try {
    await waitFor(`${base}/api/v1/health`);

    // Create a project pointing at the seeded directory.
    const created = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "demo", path: projectPath },
      auth,
    );
    assert("POST /projects → 201", created.status === 201);
    const projectId = (created.body as { id: string }).id;
    // project-manager.createProject realpaths the input path before
    // storing it (so symlinks can't bypass the workspace boundary).
    // On macOS that turns the test's `/var/folders/...` into
    // `/private/var/folders/...` — using the un-realpath'd path for
    // file ops produces "path is outside the project root" 403s.
    const canonicalProjectPath = (created.body as { path: string }).path;

    // ---- /files/tree ----
    {
      const r = await jget(
        `${base}/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}`,
        auth,
      );
      assert("GET /files/tree → 200", r.status === 200);
      const tree = r.body as TreeNode;
      const paths = flattenTree(tree);
      assert("tree includes src/index.ts", paths.includes("file:src/index.ts"), paths.join(", "));
      assert(
        "tree includes nested src/deep/nested.txt",
        paths.includes("file:src/deep/nested.txt"),
      );
      assert("tree includes in-root linked files", paths.includes("file:linked-index.ts"));
      assert(
        "tree EXCLUDES node_modules",
        !paths.some((p) => p.startsWith("directory:node_modules")),
      );
      assert("tree EXCLUDES .git", !paths.some((p) => p.startsWith("directory:.git")));
      assert("tree EXCLUDES dist", !paths.some((p) => p.startsWith("directory:dist")));
      assert(
        "tree default depth includes level 7 leaf",
        paths.includes("file:d1/d2/d3/d4/d5/d6/d7/leaf.txt"),
      );
      const cap32 = findTreeNode(tree, cappedParts.slice(0, 32).join("/"));
      assert("tree default depth caps at level 32", cap32?.truncated === true);
      assert(
        "tree default depth excludes level 33 leaf",
        !paths.includes(`file:${cappedParts.join("/")}/leaf.txt`),
      );
      assert("tree project_not_found → 404", true); // sanity: covered below
    }
    {
      const r = await jget(
        `${base}/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}&maxDepth=999`,
        auth,
      );
      assert("GET /files/tree?maxDepth=999 → 200", r.status === 200);
      const tree = r.body as TreeNode;
      const cap32 = findTreeNode(tree, cappedParts.slice(0, 32).join("/"));
      assert("tree clamps requested maxDepth to 32", cap32?.truncated === true);
    }
    {
      const r = await jget(
        `${base}/api/v1/files/tree?projectId=00000000-0000-0000-0000-000000000000`,
        auth,
      );
      assert("GET /files/tree?projectId=<unknown> → 404", r.status === 404);
    }

    // ---- write + read roundtrip ----
    const newFile = join(canonicalProjectPath, "src", "added.ts");
    {
      const w = await jsend(
        "PUT",
        `${base}/api/v1/files/write`,
        { projectId, path: newFile, content: "export const y = 2;\n" },
        auth,
      );
      assert("PUT /files/write → 200", w.status === 200, JSON.stringify(w.body));

      const qs = new URLSearchParams({ projectId, path: newFile }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("GET /files/read → 200", r.status === 200);
      const read = r.body as { content: string; language: string; binary: boolean };
      assert("read.content matches written content", read.content === "export const y = 2;\n");
      assert("read.language === 'typescript'", read.language === "typescript");
      assert("read.binary === false", read.binary === false);
    }

    // ---- write to a nested non-existent directory creates parents ----
    {
      const deep = join(canonicalProjectPath, "newdir", "child", "hello.md");
      const w = await jsend(
        "PUT",
        `${base}/api/v1/files/write`,
        { projectId, path: deep, content: "# hi\n" },
        auth,
      );
      assert("PUT /files/write to new nested dir → 200", w.status === 200);
    }

    // ---- rename ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/files/rename`,
        { projectId, path: newFile, name: "renamed.ts" },
        auth,
      );
      assert("POST /files/rename → 200", r.status === 200);
      const newPath = (r.body as { path: string }).path;
      assert("renamed path basename === 'renamed.ts'", newPath.endsWith("/renamed.ts"));

      const oldQs = new URLSearchParams({ projectId, path: newFile }).toString();
      const oldRead = await jget(`${base}/api/v1/files/read?${oldQs}`, auth);
      assert("old path → 404", oldRead.status === 404);

      const newQs = new URLSearchParams({ projectId, path: newPath }).toString();
      const newRead = await jget(`${base}/api/v1/files/read?${newQs}`, auth);
      assert("new path → 200", newRead.status === 200);
    }

    // ---- move (across dirs) ----
    let movedDest = "";
    {
      const src = join(canonicalProjectPath, "src", "renamed.ts");
      const dest = join(canonicalProjectPath, "moved.ts");
      const r = await jsend("POST", `${base}/api/v1/files/move`, { projectId, src, dest }, auth);
      assert("POST /files/move → 200", r.status === 200);
      movedDest = (r.body as { path: string }).path;

      const qs = new URLSearchParams({ projectId, path: movedDest }).toString();
      const read = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("file readable at new dest", read.status === 200);
    }

    // ---- delete file ----
    {
      const qs = new URLSearchParams({ projectId, path: movedDest }).toString();
      const d = await jsend("DELETE", `${base}/api/v1/files/delete?${qs}`, undefined, auth);
      assert("DELETE /files/delete (file) → 204", d.status === 204);
      const read = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("file gone after delete → 404", read.status === 404);
    }

    // ---- upload files with folder-relative paths ----
    {
      const fd = new FormData();
      fd.append("projectId", projectId);
      fd.append("parentPath", canonicalProjectPath);
      fd.append("path:0", "dropped-folder/alpha.txt");
      fd.append("sha256:0", "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8");
      fd.append("path:1", "dropped-folder/nested/beta.txt");
      fd.append("sha256:1", "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753");
      fd.append("file:0", new Blob(["alpha"]), "dropped-folder/alpha.txt");
      fd.append("file:1", new Blob(["beta"]), "dropped-folder/nested/beta.txt");
      const res = await fetch(`${base}/api/v1/files/upload`, {
        method: "POST",
        headers: auth,
        body: fd,
      });
      const body = (await res.json()) as { files?: { path: string }[] };
      assert("POST /files/upload folder paths → 200", res.status === 200, JSON.stringify(body));
      assert("upload returns two files", body.files?.length === 2, JSON.stringify(body));
      const alpha = await fsRead(join(projectPath, "dropped-folder", "alpha.txt"), "utf8");
      const beta = await fsRead(join(projectPath, "dropped-folder", "nested", "beta.txt"), "utf8");
      assert("folder upload writes top-level file", alpha === "alpha");
      assert("folder upload writes nested file", beta === "beta");
    }
    {
      const fd = new FormData();
      fd.append("projectId", projectId);
      fd.append("parentPath", canonicalProjectPath);
      fd.append("path:0", "../escape.txt");
      fd.append("file:0", new Blob(["escape"]), "escape.txt");
      const res = await fetch(`${base}/api/v1/files/upload`, {
        method: "POST",
        headers: auth,
        body: fd,
      });
      assert("POST /files/upload traversal folder path → 403", res.status === 403);
    }

    // ---- mkdir + duplicate + delete empty ----
    {
      const make = await jsend(
        "POST",
        `${base}/api/v1/files/mkdir`,
        { projectId, parentPath: canonicalProjectPath, name: "fresh" },
        auth,
      );
      assert("POST /files/mkdir → 200", make.status === 200);

      const dup = await jsend(
        "POST",
        `${base}/api/v1/files/mkdir`,
        { projectId, parentPath: canonicalProjectPath, name: "fresh" },
        auth,
      );
      assert("POST /files/mkdir duplicate → 409 target_exists", dup.status === 409);

      const freshPath = join(canonicalProjectPath, "fresh");
      const qs = new URLSearchParams({ projectId, path: freshPath }).toString();
      const d = await jsend("DELETE", `${base}/api/v1/files/delete?${qs}`, undefined, auth);
      assert("DELETE empty dir → 204", d.status === 204);
    }

    // ---- delete non-empty directory → 409 ----
    {
      const qs = new URLSearchParams({
        projectId,
        path: join(canonicalProjectPath, "src"),
      }).toString();
      const d = await jsend("DELETE", `${base}/api/v1/files/delete?${qs}`, undefined, auth);
      assert("DELETE non-empty dir → 409 directory_not_empty", d.status === 409);
    }

    // ---- path traversal (read) ----
    {
      const qs = new URLSearchParams({
        projectId,
        path: join(projectPath, "..", "..", "etc", "passwd"),
      }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("read with traversal → 403", r.status === 403);
    }

    // ---- write outside project root → 403 ----
    {
      const w = await jsend(
        "PUT",
        `${base}/api/v1/files/write`,
        { projectId, path: "/tmp/escape.txt", content: "no" },
        auth,
      );
      assert("write outside project → 403", w.status === 403);
    }

    // ---- delete project root itself → 403 ----
    {
      const qs = new URLSearchParams({ projectId, path: canonicalProjectPath }).toString();
      const r = await jsend("DELETE", `${base}/api/v1/files/delete?${qs}`, undefined, auth);
      // Either 403 (path_not_allowed) or 409 (directory_not_empty) is
      // acceptable — both keep the root from being clobbered. Assert the
      // safer one (403) since file-manager has the explicit check.
      assert("delete project root → 403", r.status === 403);
    }

    // ---- binary file ----
    {
      const qs = new URLSearchParams({
        projectId,
        path: join(canonicalProjectPath, "logo.png"),
      }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("read binary → 200", r.status === 200);
      const body = r.body as { binary: boolean; content: string };
      assert("binary file: binary === true", body.binary === true);
      assert("binary file: content empty", body.content === "");
    }

    // ---- symlink-out-of-root rejection ----
    // Plant a symlink inside the project that points OUT of the
    // project root. The lexical path-check would say "inside" (the
    // symlink itself is inside), so without realpath resolution this
    // would let an attacker read /etc/passwd via /<project>/escape.
    {
      // For the symlink primitive itself we use the un-realpath'd
      // projectPath so node fs writes through to the actual path on
      // disk. For the HTTP request below, switch to the canonical
      // form the server has stored.
      const escapeLink = join(projectPath, "escape");
      const escapeLinkCanonical = join(canonicalProjectPath, "escape");
      const outside = "/etc/hosts";
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, escapeLink);
      const qs = new URLSearchParams({ projectId, path: escapeLinkCanonical }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("read through symlink-out-of-root → 403", r.status === 403);
      // Same for a write target that resolves through the escape link.
      const w = await jsend(
        "PUT",
        `${base}/api/v1/files/write`,
        { projectId, path: escapeLinkCanonical, content: "no" },
        auth,
      );
      assert("write through symlink-out-of-root → 403", w.status === 403);
    }

    // ---- NUL-byte rejection ----
    // Without an explicit check, fs.* throws ERR_INVALID_ARG_VALUE
    // ("string contains null bytes") — a non-Error.code shape
    // our mapper falls through to a 500. We convert these into 403.
    {
      const sneaky = canonicalProjectPath + "/foo" + String.fromCharCode(0) + ".ts";
      const qs = new URLSearchParams({ projectId, path: sneaky }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("read with NUL-byte in path → 403 (not 500)", r.status === 403);
      const w = await jsend(
        "PUT",
        `${base}/api/v1/files/write`,
        { projectId, path: sneaky, content: "x" },
        auth,
      );
      assert("write with NUL-byte in path → 403 (not 500)", w.status === 403);
    }

    // ---- file-too-large (5 MB cap) ----
    {
      // Write through projectPath (the un-realpath'd path Node fs
      // accepts directly) but query through the canonical form.
      const big = join(projectPath, "big.txt");
      const bigCanonical = join(canonicalProjectPath, "big.txt");
      const buf = Buffer.alloc(6 * 1024 * 1024, "a"); // 6 MB > 5 MB read cap
      await fsWrite(big, buf);
      const qs = new URLSearchParams({ projectId, path: bigCanonical }).toString();
      const r = await jget(`${base}/api/v1/files/read?${qs}`, auth);
      assert("read 6MB file → 413 file_too_large", r.status === 413);
    }

    // ---- unauthenticated request → 401 ----
    {
      const r = await jget(`${base}/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}`);
      assert("anonymous /files/tree → 401", r.status === 401);
    }
  } finally {
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-files] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-files] PASS");
}

main().catch((err: unknown) => {
  console.error("[test-files] uncaught:", err);
  process.exit(1);
});
