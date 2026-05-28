import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ArchiveMetadata {
  version: 1;
  sessionId: string;
  projectId?: string;
  originalSessionPath: string;
  archivedAt: string;
  purgeAfter: string;
  sessionFile: string;
  subagentDir?: string;
}

function safeStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

async function movePath(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
    const s = await stat(src);
    if (s.isDirectory()) {
      await cp(src, dest, { recursive: true, force: false, errorOnExist: true });
      await rm(src, { recursive: true, force: true });
    } else {
      await cp(src, dest, { force: false, errorOnExist: true });
      await rm(src, { force: true });
    }
  }
}

/**
 * Soft-delete a session by moving its JSONL (and optional pi-subagents
 * sibling directory) out of the live session tree. The normal discovery path
 * no longer sees it, so it disappears from the UI immediately, while the files
 * remain recoverable on disk until cleanupArchivedSessions purges them.
 */
export async function archiveSessionFiles(args: {
  sessionId: string;
  projectId?: string;
  sessionPath: string;
  subagentDir?: string;
}): Promise<void> {
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + RETENTION_MS);
  const archiveId = `${safeStamp(now)}-${args.sessionId}-${randomUUID().slice(0, 8)}`;
  const archiveDir = join(config.forgeDataDir, "archived-sessions", archiveId);
  await mkdir(archiveDir, { recursive: true });

  const sessionFile = basename(args.sessionPath) || "session.jsonl";
  await movePath(args.sessionPath, join(archiveDir, sessionFile));

  let subagentDirName: string | undefined;
  if (args.subagentDir !== undefined) {
    try {
      const s = await stat(args.subagentDir);
      if (s.isDirectory()) {
        subagentDirName = "subagents";
        await movePath(args.subagentDir, join(archiveDir, subagentDirName));
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  const metadata: ArchiveMetadata = {
    version: 1,
    sessionId: args.sessionId,
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    originalSessionPath: args.sessionPath,
    archivedAt: now.toISOString(),
    purgeAfter: purgeAfter.toISOString(),
    sessionFile,
    ...(subagentDirName !== undefined ? { subagentDir: subagentDirName } : {}),
  };
  await writeFile(join(archiveDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Remove archived sessions whose 7-day retention window has expired. */
export async function cleanupArchivedSessions(now = new Date()): Promise<number> {
  const root = join(config.forgeDataDir, "archived-sessions");
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let purge: boolean;
    try {
      const raw = await readFile(join(dir, "metadata.json"), "utf8");
      const meta = JSON.parse(raw) as { purgeAfter?: unknown };
      purge = typeof meta.purgeAfter === "string" && Date.parse(meta.purgeAfter) <= now.getTime();
    } catch {
      // If metadata is missing/corrupt, fall back to directory mtime so a bad
      // archive entry cannot live forever.
      const s = await stat(dir).catch(() => undefined);
      purge = s !== undefined && now.getTime() - s.mtimeMs >= RETENTION_MS;
    }
    if (!purge) continue;
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
