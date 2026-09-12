import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

const lock = makeLock();
let cache: Record<string, string> | undefined;

async function readIdentities(): Promise<Record<string, string>> {
  if (cache !== undefined) return cache;
  try {
    const parsed = JSON.parse(await readFile(config.sessionIdentityFile, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cache = {};
      return cache;
    }
    cache = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[0].length > 0 &&
          entry[1].length > 0,
      ),
    );
    return cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = {};
      return cache;
    }
    throw err;
  }
}

export async function usernameForSession(sessionId: string): Promise<string | undefined> {
  return (await readIdentities())[sessionId];
}

export async function rememberSessionUsername(sessionId: string, username: string): Promise<void> {
  await lock(async () => {
    const identities = await readIdentities();
    if (identities[sessionId] === username) return;
    const next = { ...identities, [sessionId]: username };
    const tmp = `${config.sessionIdentityFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, config.sessionIdentityFile);
    cache = next;
  });
}
