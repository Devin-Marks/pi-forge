import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-process log storage. Two channels:
 *   - In-memory ring buffer of recent lines (the chat panel reads
 *     a tail for inline display)
 *   - Append-only disk file (full history; the `logs` action
 *     returns the absolute path so the agent can read it, and the
 *     UI streams it for the "view full log" view)
 *
 * Rotation: when the disk file passes MAX_BYTES, it's renamed to
 * `.1` (overwriting any prior `.1`) and a fresh file is opened.
 * One backup is enough — agents don't need yesterday's noise.
 */

export interface LogStoreOptions {
  ringMaxLines: number;
  ringMaxBytes: number;
  diskMaxBytes: number;
}

export const DEFAULT_OPTIONS: LogStoreOptions = {
  ringMaxLines: 1_000,
  ringMaxBytes: 64 * 1024,
  diskMaxBytes: 10 * 1024 * 1024,
};

/**
 * One per process+stream. Owns its WriteStream (closes on dispose)
 * and a ring buffer of recent lines split on `\n`. The append()
 * call is synchronous-looking from the caller's perspective — the
 * write to disk is fire-and-forget through the stream's internal
 * buffer.
 */
export class LogChannel {
  private readonly opts: LogStoreOptions;
  private readonly filePath: string;
  private stream: WriteStream;
  private byteCount = 0;
  private rotating = false;
  /** Pending tail of an incoming chunk that didn't end on a newline. */
  private partial = "";
  /** Most-recent N lines; oldest evicted first. */
  private readonly lines: string[] = [];
  private linesBytes = 0;
  private disposed = false;

  constructor(filePath: string, opts: Partial<LogStoreOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.stream = createWriteStream(filePath, { flags: "a" });
  }

  /**
   * Push a chunk of process output. Splits on `\n` to update the
   * ring buffer (and to feed log watches via the caller's
   * `onLine` callback). Disk write is the raw chunk — preserves
   * the original bytes including any embedded carriage returns
   * the process emitted.
   */
  append(chunk: Buffer, onLine?: (line: string) => void): void {
    if (this.disposed) return;
    const bytes = chunk.length;
    this.byteCount += bytes;
    this.stream.write(chunk);
    // Maybe rotate AFTER writing — the file is what we want to cap,
    // not the chunk size.
    if (this.byteCount >= this.opts.diskMaxBytes && !this.rotating) {
      void this.rotate();
    }
    const text = chunk.toString("utf8");
    let buf = this.partial + text;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      this.pushLine(line);
      if (onLine !== undefined) onLine(line);
      nl = buf.indexOf("\n");
    }
    this.partial = buf;
  }

  private pushLine(line: string): void {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    this.lines.push(line);
    this.linesBytes += bytes;
    while (this.lines.length > this.opts.ringMaxLines || this.linesBytes > this.opts.ringMaxBytes) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.linesBytes -= Buffer.byteLength(dropped, "utf8") + 1;
    }
  }

  private async rotate(): Promise<void> {
    this.rotating = true;
    try {
      const backup = `${this.filePath}.1`;
      // Close the current stream so the rename succeeds on Windows
      // (best-effort — Unix doesn't need it but it's idempotent).
      await new Promise<void>((resolve) => this.stream.end(() => resolve()));
      await rename(this.filePath, backup).catch(() => undefined);
      this.stream = createWriteStream(this.filePath, { flags: "a" });
      // Re-stat to refresh byteCount (the rename happens to a
      // possibly-stale `byteCount` value if writes raced — re-read
      // the truth).
      try {
        const st = await stat(this.filePath);
        this.byteCount = st.size;
      } catch {
        this.byteCount = 0;
      }
    } finally {
      this.rotating = false;
    }
  }

  /** Latest N lines (default: all retained). */
  tail(n?: number): string[] {
    if (n === undefined || n >= this.lines.length) return [...this.lines];
    return this.lines.slice(this.lines.length - n);
  }

  filePathOnDisk(): string {
    return this.filePath;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Flush any partial line into the ring buffer (no trailing
    // newline, but the user-visible "last line" makes sense).
    if (this.partial.length > 0) {
      this.pushLine(this.partial);
      this.partial = "";
    }
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/**
 * Resolve a process's log directory under the session's tree.
 * Lives in FORGE_DATA_DIR so it cascades with the rest of the
 * forge's per-session state when a session is cold-deleted.
 */
export function processLogDir(forgeDataDir: string, sessionId: string, processId: string): string {
  return join(forgeDataDir, "processes", sessionId, processId);
}
