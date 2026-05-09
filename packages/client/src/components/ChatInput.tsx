import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AtSign, Image as ImageIcon, Paperclip, RotateCcw, X } from "lucide-react";
import { api, ApiError, type ProvidersListing } from "../lib/api-client";
import { EMPTY_MESSAGES, useSessionStore, type AgentMessageLike } from "../store/session-store";
import { useActiveProject } from "../store/project-store";
import { useUiConfigStore } from "../store/ui-config-store";
import { useUiStore } from "../store/ui-store";

/**
 * Pull the user's prior prompts out of the session message history,
 * newest first. Used by the chat input's arrow-key history cycling.
 *
 * Mirrors `extractText` in ChatView (we can't share it without a
 * circular import; the duplication is a few lines and the
 * canonical-shape detection is identical). Drops empty strings and
 * collapses consecutive duplicates so repeatedly pressing Up doesn't
 * cycle through "yes\nyes\nyes" three times.
 *
 * Optimistic-vs-canonical convergence: `sendPrompt` appends an
 * optimistic message with `content: text` (string form) before the
 * SDK confirms; on `agent_end` the canonical refetch replaces it
 * with the array-of-blocks form. Both shapes extract to the SAME
 * trimmed string here, so the consecutive-duplicate dedupe collapses
 * the brief overlap to a single history entry.
 */
/**
 * Parse `@<path>` references out of the current draft. Mirrors the
 * server's regex in `file-references.ts` — same prefix anchor (start
 * or whitespace), same quoted/unquoted forms. The badge row in the
 * input header reads from this so users can see which files this turn
 * will reference.
 */
function parseChatFileReferences(text: string): string[] {
  // Lazy bare alternation + lookahead so trailing sentence punctuation
  // (`?`, `,`, `;`, `:`, `!`, `)`, `]`) doesn't get glued onto the
  // path — kept in sync with the server-side REF_RE in
  // file-references.ts. See that file for the rationale.
  const re = /(?:^|\s)@(?:"([^"\n]+)"|([^\s]+?))(?=[?,;:!)\]]?(?:\s|$))/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1] ?? m[2];
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Escape a string for safe inclusion in a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches the `@<path>` (or `@"<path>"`) form
 * preceded by start-of-string or whitespace, plus any trailing space.
 * Used by the chip's X button to yank the reference from the draft.
 */
function buildFileRefRegex(path: string): RegExp {
  const escaped = escapeRegExp(path);
  // Match optional leading whitespace (kept on the line so removing
  // a chip doesn't yank the user's surrounding space) plus the marker
  // in either quoted or unquoted form, plus an optional trailing
  // space so we don't leave a double-space behind.
  return new RegExp(`(^|\\s)@(?:"${escaped}"|${escaped})\\s?`, "g");
}

/**
 * Per-session input history backed by localStorage. Captures EVERY
 * submission (regular prompts, `/slash` commands, `!bash` execs,
 * mid-turn steers) so up-arrow recall surfaces the same set of
 * inputs the user actually typed — not just the ones that round-
 * tripped to the agent. Newest first; capped at HISTORY_LIMIT to
 * keep storage bounded across long-lived sessions.
 */
const HISTORY_LIMIT = 100;
const HISTORY_KEY_PREFIX = "forge.input.history.v1:";

function readInputHistory(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY_PREFIX + sessionId);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function pushInputHistory(sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  try {
    const cur = readInputHistory(sessionId);
    // Skip if the most recent entry is identical (no point recording
    // back-to-back duplicates the same way bash's `HISTCONTROL=ignoredups`
    // works).
    if (cur[0] === trimmed) return;
    const next = [trimmed, ...cur].slice(0, HISTORY_LIMIT);
    localStorage.setItem(HISTORY_KEY_PREFIX + sessionId, JSON.stringify(next));
  } catch {
    // private-mode storage failure — still works for the current
    // browser-tab session via the ref-based fallback below.
  }
}

function userHistory(messages: readonly AgentMessageLike[]): string[] {
  const out: string[] = [];
  let last: string | undefined;
  // Iterate newest-to-oldest so the resulting array is ordered for
  // direct indexing: out[0] = most recent.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        const o = c as { type?: unknown; text?: unknown };
        if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (text.length === 0) continue;
    if (text === last) continue;
    out.push(text);
    last = text;
  }
  return out;
}

interface Props {
  sessionId: string;
}

const MODEL_KEY_PREFIX = "pi-forge/model/";

interface ModelOption {
  value: string; // "<provider>:<modelId>"
  provider: string;
  modelId: string;
  name: string;
  /** Lowercased haystack used for substring/word search. */
  haystack: string;
}

function flattenModels(providers: ProvidersListing | undefined): ModelOption[] {
  if (providers === undefined) return [];
  const out: ModelOption[] = [];
  for (const p of providers.providers) {
    for (const m of p.models) {
      if (!m.hasAuth) continue;
      out.push({
        value: `${p.provider}:${m.id}`,
        provider: p.provider,
        modelId: m.id,
        name: m.name,
        haystack: `${p.provider} ${m.name} ${m.id}`.toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * Score a model option against a search query. Returns `undefined` when
 * any token isn't found in the haystack; otherwise a number where
 * LOWER is better. Prefix and provider-equals matches get a strong
 * negative boost so popular models float to the top of OpenRouter's
 * 200+ list — those negative scores ARE matches and must not be
 * filtered out as "no match."
 */
function scoreOption(opt: ModelOption, query: string): number | undefined {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  let score = 0;
  for (const t of tokens) {
    const idx = opt.haystack.indexOf(t);
    if (idx === -1) return undefined;
    score += idx;
  }
  if (opt.modelId.toLowerCase().startsWith(q)) score -= 50;
  if (opt.name.toLowerCase().startsWith(q)) score -= 30;
  if (opt.provider.toLowerCase() === q) score -= 20;
  return score;
}

/**
 * Phase 8 chat input. One Send button + (while streaming) Abort.
 *
 * - Idle: Send → POST /prompt.
 * - Streaming: Send → POST /steer (Pi's SDK picks steer-vs-followUp
 *   natively based on whether the agent is mid-tool-call or
 *   mid-text; we don't try to second-guess it).
 * - Abort is its own button so it can't be hit by accident from a
 *   misclick on Send. Pressing Esc twice inside the textarea (within
 *   600 ms) also fires Abort — keyboard-only path for users who
 *   never leave the input.
 *
 * Enter submits, Shift+Enter inserts a newline. The model selector
 * lives alongside in this same phase; attachments and token/cost
 * display land in later phases.
 */
const DOUBLE_ESC_WINDOW_MS = 600;

export function ChatInput({ sessionId }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  // Minimal-mode deploys disable the chat-input bash exec (`!` /
  // `!!`) — locked-down installs can't justify giving end users a
  // direct shell. The agent's own `bash` tool is unaffected; the
  // restriction is on the *user* typing raw shell into chat.
  const minimalUi = useUiConfigStore((s) => s.minimal);
  const banner = useSessionStore((s) => s.bannerBySession[sessionId]);
  // Detect an in-progress auto-retry by the banner shape that
  // session-store sets in applyEvent for `auto_retry_start`. This lets
  // the chat input show a clarifying placeholder so the user knows a
  // new prompt during a retry will be queued (rather than discarded
  // or replacing the in-flight message).
  const isAutoRetrying = banner !== undefined && banner.startsWith("Retrying (");
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const sendSteer = useSessionStore((s) => s.sendSteer);
  const reloadMessages = useSessionStore((s) => s.reloadMessages);
  const abortSession = useSessionStore((s) => s.abortSession);
  const error = useSessionStore((s) => s.error);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // ----- @-completion (file references in the chat input) -----
  // The popover is "open" when `acToken` is set; that happens whenever
  // the caret is inside an `@<query>` token (the `@` is at start-of-
  // text or after whitespace, with no whitespace between `@` and the
  // caret). The popover content comes from /files/complete on a 100ms
  // debounce. Tab/Enter inserts the highlighted suggestion, ↑/↓
  // navigates, Esc closes. Inserting REPLACES the partial token with
  // `@<full-path>` (the server expands `@<path>` to a fenced code
  // block at send time — see file-references.ts).
  const project = useActiveProject();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * User-chosen textarea height in pixels, driven by the drag handle
   * that lives where the composer's top border used to be. `undefined`
   * means "use the default `rows={3}` layout"; once the user drags,
   * it becomes a concrete number that overrides via inline style.
   *
   * Persisted under a window-scoped localStorage key — per-session
   * heights would just confuse (one preferred draft size beats N
   * session-scoped sizes the user has to re-discover on every
   * switch). Clamp on read so a stale absurd value gets corrected
   * silently. Bounds: min 60 px (~2 rows), max 60 % viewport.
   */
  const HEIGHT_KEY = "pi-forge:chat-input-height";
  const heightBounds = (): { min: number; max: number } => ({
    min: 60,
    max: Math.floor(window.innerHeight * 0.6),
  });
  const [textareaHeight, setTextareaHeight] = useState<number | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = window.localStorage.getItem(HEIGHT_KEY);
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return undefined;
    const { min, max } = heightBounds();
    return Math.max(min, Math.min(max, parsed));
  });

  /**
   * Pointer-driven drag handler for the divider above the composer.
   * Drag UP = textarea grows; drag DOWN = shrinks. Persistence and
   * pointer release happen at pointerup. We capture the pointer so
   * the drag survives even if the cursor leaves the slim handle
   * during a fast move.
   *
   * Why pointer events (not mousedown/mousemove): pointer capture +
   * unified handling for touch/pen/mouse + we don't have to wire up
   * a window-scoped move listener manually.
   */
  const startDividerDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = textareaRef.current?.getBoundingClientRect().height ?? 60;
    const { min, max } = heightBounds();

    const onMove = (ev: PointerEvent): void => {
      // Inverted: dragging UP (clientY decreases) should grow the
      // textarea, since the handle sits ABOVE the composer.
      const delta = startY - ev.clientY;
      const next = Math.max(min, Math.min(max, startHeight + delta));
      setTextareaHeight(next);
    };
    const onUp = (ev: PointerEvent): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        // capture may already be released; ignore
      }
      // Persist whatever height the textarea actually has now —
      // reads from the live element, not from React state, so a
      // mid-drag re-render won't desync the saved value.
      const live = textareaRef.current?.getBoundingClientRect().height;
      if (live !== undefined && Number.isFinite(live)) {
        window.localStorage.setItem(HEIGHT_KEY, String(Math.round(live)));
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  /**
   * Reset the composer to its default `rows={3}` size. Drops the
   * inline-style override so the textarea picks up its CSS-derived
   * default, and clears the persisted height so the next mount
   * doesn't restore the old value. The button rendering this is
   * conditional on `textareaHeight !== undefined`, so the affordance
   * disappears once it's done its job — no clutter for the common
   * "I never resized" case.
   */
  const resetTextareaHeight = (): void => {
    setTextareaHeight(undefined);
    window.localStorage.removeItem(HEIGHT_KEY);
  };
  interface AcToken {
    /** index of the `@` in `text`. */
    start: number;
    /** index just past the partial query (= caret position). */
    end: number;
    /** the partial query (everything between `@` and `end`). */
    query: string;
  }
  const [acToken, setAcToken] = useState<AcToken | undefined>(undefined);
  const [acSuggestions, setAcSuggestions] = useState<string[]>([]);
  const [acSelectedIdx, setAcSelectedIdx] = useState(0);
  const acFetchSeqRef = useRef(0); // discard stale fetches on rapid typing

  // ----- /-commands (slash command palette) -----
  // Triggered when the WHOLE input starts with `/`. The user types
  // `/co` to filter; ↑/↓ to navigate; Enter or Tab to execute. Esc
  // closes. Backspacing through the `/` closes too. Each command is
  // a synchronous handler defined below; commands that need server
  // I/O resolve via the existing api-client / store actions.
  const openSettings = useUiStore((s) => s.openSettings);
  const chatInsertRequest = useUiStore((s) => s.chatInsertRequest);
  const clearChatInsertRequest = useUiStore((s) => s.clearChatInsertRequest);
  const lastChatInsertSeqRef = useRef(0);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const slashOpen = text.startsWith("/") && !text.includes("\n");
  const slashQuery = slashOpen ? (text.slice(1).split(/\s/)[0] ?? "") : "";

  /**
   * Pi prompt templates available for the active project, surfaced in
   * the slash-command palette as `/<promptname>` entries. The pi SDK's
   * `session.prompt()` expands the template at send time (defaults to
   * `expandPromptTemplates: true`), so we don't expand client-side or
   * server-side — the palette is purely a discovery + filling-in
   * affordance. Selecting a prompt entry inserts `/<promptname> ` into
   * the input (with trailing space) so the user can append args
   * before pressing Enter.
   *
   * Refetched on project change. Errors silently swallow — a
   * prompts-fetch failure shouldn't block the input from working;
   * the user just sees the standard slash-command catalog without
   * project prompts.
   */
  const [availablePrompts, setAvailablePrompts] = useState<
    { name: string; description: string; argumentHint?: string }[]
  >([]);
  useEffect(() => {
    if (project === undefined) {
      setAvailablePrompts([]);
      return;
    }
    let cancelled = false;
    void api
      .listPrompts(project.id)
      .then((res) => {
        if (cancelled) return;
        // Only surface prompts that are actually enabled for this
        // project — matches what `session.prompt()` will be able to
        // expand at send time.
        setAvailablePrompts(
          res.prompts
            .filter((p) => p.effective)
            .map((p) => {
              const out: { name: string; description: string; argumentHint?: string } = {
                name: p.name,
                description: p.description,
              };
              if (p.argumentHint !== undefined) out.argumentHint = p.argumentHint;
              return out;
            }),
        );
      })
      .catch(() => {
        if (!cancelled) setAvailablePrompts([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Bang-prefix mode for the visual treatment around the textarea.
  // `!!` runs bash local-only (output stays out of LLM context); `!`
  // runs bash AND feeds the output into the next turn. Both only fire
  // on submit when the session isn't streaming, so we gate the cue on
  // the same condition to avoid promising behavior we won't deliver.
  const bangMode: "context" | "local" | undefined = (() => {
    if (isStreaming) return undefined;
    // Bash exec is disabled in minimal — don't promise a mode the
    // submit handler will refuse.
    if (minimalUi) return undefined;
    if (text.startsWith("!!")) return "local";
    if (text.startsWith("!")) return "context";
    return undefined;
  })();

  interface SlashCommand {
    name: string; // "/compact"
    description: string;
    /** When false, the command is in the catalog but disabled (gray
     *  + non-selectable). Used by `/abort` to reflect "session not
     *  streaming." */
    available: boolean;
    run: () => void | Promise<void>;
  }

  const slashCatalog = useMemo<SlashCommand[]>(() => {
    const commands: SlashCommand[] = [
      {
        name: "/compact",
        description: "Manually compact the session context",
        available: !isStreaming,
        run: async () => {
          try {
            await api.compact(sessionId);
            reloadMessages(sessionId);
          } catch (err) {
            const code = err instanceof ApiError ? err.code : (err as Error).message;
            setAttachmentError(`Compact failed: ${code}`);
          }
        },
      },
      {
        name: "/clear",
        description: "Compact context (alias for /compact)",
        available: !isStreaming,
        run: async () => {
          try {
            await api.compact(sessionId);
            reloadMessages(sessionId);
          } catch (err) {
            const code = err instanceof ApiError ? err.code : (err as Error).message;
            setAttachmentError(`Clear failed: ${code}`);
          }
        },
      },
      {
        name: "/abort",
        description: "Stop the agent (alias for the Abort button)",
        available: isStreaming,
        run: () => abortSession(sessionId),
      },
      {
        name: "/settings",
        description: "Open the Settings panel",
        available: true,
        run: () => openSettings(),
      },
      {
        name: "/skills",
        description: "Open Settings → Skills",
        available: true,
        run: () => openSettings("skills"),
      },
      {
        name: "/mcp",
        description: "Open Settings → MCP",
        available: true,
        run: () => openSettings("mcp"),
      },
      {
        name: "/providers",
        description: "Open Settings → Providers",
        available: true,
        run: () => openSettings("providers"),
      },
      {
        name: "/help",
        description: minimalUi
          ? "Show what `/` and `@` do in the input"
          : "Show what `/`, `!`, `@` do in the input",
        available: true,
        run: () => {
          setAttachmentError(
            minimalUi
              ? "/<cmd> runs a pi-forge command (compact, abort, settings, …). " +
                  "@<path> references a project file (autocomplete from the popover)."
              : "/<cmd> runs a pi-forge command (compact, abort, settings, …). " +
                  "!cmd runs bash (output → next LLM context); !!cmd runs bash local-only. " +
                  "@<path> references a project file (autocomplete from the popover).",
          );
        },
      },
    ];
    // Append pi prompt templates after the built-in commands. The
    // SDK's `session.prompt()` expands `/<promptname> args` to the
    // template body at send time (`expandPromptTemplates: true` by
    // default in pi). Selecting one here just inserts the `/<name> `
    // into the input; the user fills in args, presses Enter, and pi
    // expands before forwarding to the model.
    for (const p of availablePrompts) {
      const description =
        p.argumentHint !== undefined ? `${p.description} — args: ${p.argumentHint}` : p.description;
      commands.push({
        name: `/${p.name}`,
        description,
        available: !isStreaming,
        run: () => {
          // Insert `/<name> ` (trailing space) into the input — user
          // appends arg(s) and presses Enter.
          const insert = `/${p.name} `;
          setText(insert);
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (ta === null) return;
            ta.focus();
            ta.setSelectionRange(insert.length, insert.length);
          });
        },
      });
    }
    return commands;
  }, [
    isStreaming,
    sessionId,
    abortSession,
    reloadMessages,
    openSettings,
    minimalUi,
    availablePrompts,
  ]);

  const slashFiltered = useMemo(() => {
    const q = slashQuery.toLowerCase();
    if (q.length === 0) return slashCatalog;
    return slashCatalog.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
  }, [slashCatalog, slashQuery]);

  /**
   * True when the input text is in `/<knownpromptname>` or
   * `/<knownpromptname> ...args` form. In those cases Enter should
   * BYPASS slash-command dispatch and fall through to a normal submit
   * — pi's `session.prompt()` will expand the template at send time.
   * Without this bypass, Enter on `/<name> foo` re-fires the prompt
   * entry's `run()` which re-inserts `/<name> ` and clobbers the args.
   *
   * Distinguishes from the still-typing-the-name case (e.g. text is
   * `/sum` while a prompt is named `summarize`) — that DOES go through
   * normal slash dispatch so Enter Tab-completes the name.
   */
  const isPromptInvocation = useMemo(() => {
    if (!slashOpen) return false;
    const firstWord = text.slice(1).split(/\s/)[0] ?? "";
    if (firstWord.length === 0) return false;
    if (!availablePrompts.some((p) => p.name === firstWord)) return false;
    return text === `/${firstWord}` || text.startsWith(`/${firstWord} `);
  }, [slashOpen, text, availablePrompts]);

  const slashRunSelected = (): void => {
    const cmd = slashFiltered[slashSelectedIdx];
    if (cmd === undefined || !cmd.available) return;
    setText("");
    setSlashSelectedIdx(0);
    void cmd.run();
  };
  // Timestamp of the most recent Esc keystroke; second Esc within
  // DOUBLE_ESC_WINDOW_MS triggers abort. Lives in a ref so it
  // doesn't force a re-render on every Esc.
  const lastEscRef = useRef<number>(0);

  // Attachment state — File objects selected via the picker, queued
  // to ride along with the next prompt. Cleared on submit. Object
  // URLs for image previews are tracked in a ref so we can revoke
  // them on remove/submit (no leak on long sessions).
  const [attachments, setAttachments] = useState<File[]>([]);
  const previewUrlsRef = useRef<Map<File, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Per-file size + count limits mirror the server's. Validating
  // client-side gives instant feedback; the server still re-checks.
  // The 20 MB cap is the only upper bound — it exists for memory
  // pressure during multipart parsing, not LLM context. The whole
  // attached file gets sent; if the model can't fit it the provider
  // returns a clean error that surfaces in chat.
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGES = 4;
  // Server's `files: 8` cap is global (image + text combined). Mirror
  // it client-side so the UI rejects the 9th attachment with a clear
  // message instead of letting the server return `too_many_files`.
  const MAX_TOTAL_FILES = 8;
  // Common binary file extensions we know the prompt pipeline can't do
  // anything useful with (only text + supported image MIMEs reach the
  // LLM). Reject up front for instant feedback; the server's NUL-byte
  // sniff is the safety net for everything not on this list. Names
  // here are deliberately conservative — if a format ever becomes
  // useful (PDF parser, etc.) drop it from this set.
  const KNOWN_BINARY_EXTENSIONS = new Set([
    // Office / Visio / OpenDocument — `pdf`, `docx`, `xlsx` are
    // converted to text server-side and intentionally NOT in this
    // blocklist. The rest (legacy `.doc`/`.xls`, PowerPoint, Visio,
    // OpenDocument, RTF) have no conversion path yet and would land
    // as binary noise in the prompt.
    "doc",
    "xls",
    "ppt",
    "pptx",
    "vsd",
    "vsdx",
    "odt",
    "ods",
    "odp",
    "rtf",
    // Archives
    "zip",
    "tar",
    "gz",
    "bz2",
    "xz",
    "7z",
    "rar",
    // Executables / native libs
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "o",
    "a",
    "class",
    "jar",
    "wasm",
    // Media (and image formats not in IMAGE_MIME_TYPES)
    "mp3",
    "mp4",
    "m4a",
    "wav",
    "flac",
    "ogg",
    "avi",
    "mov",
    "wmv",
    "mkv",
    "heic",
    "heif",
    "tiff",
    "tif",
    "bmp",
    "ico",
    "psd",
    // Fonts / databases / disk images
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
    "sqlite",
    "db",
    "iso",
    "dmg",
  ]);
  const [attachmentError, setAttachmentError] = useState<string | undefined>(undefined);

  const addAttachments = (files: FileList | File[]): void => {
    setAttachmentError(undefined);
    const existing = attachments;
    const next: File[] = [...existing];
    let imageCount = existing.filter((f) => f.type.startsWith("image/")).length;
    for (const f of files) {
      if (next.length >= MAX_TOTAL_FILES) {
        setAttachmentError(
          `Up to ${MAX_TOTAL_FILES} attachments per message; "${f.name}" dropped.`,
        );
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        setAttachmentError(`"${f.name}" exceeds the 20 MB per-file limit.`);
        continue;
      }
      if (f.type.startsWith("image/") && imageCount >= MAX_IMAGES) {
        setAttachmentError(`Up to ${MAX_IMAGES} images per message; "${f.name}" dropped.`);
        continue;
      }
      // Known binary types the prompt pipeline can't carry (no PDF /
      // Office / Visio support yet — only text + supported images
      // reach the LLM). Reject up front so the user gets immediate
      // feedback instead of an opaque server-side `unsupported_attachment_type`.
      const ext = f.name.includes(".") ? f.name.split(".").pop()?.toLowerCase() : undefined;
      if (ext !== undefined && KNOWN_BINARY_EXTENSIONS.has(ext)) {
        setAttachmentError(
          `"${f.name}" is a binary format that the agent can't read directly. Convert to text/markdown (or to a PNG/JPEG screenshot for diagrams) and try again.`,
        );
        continue;
      }
      next.push(f);
      if (f.type.startsWith("image/")) {
        imageCount += 1;
        previewUrlsRef.current.set(f, URL.createObjectURL(f));
      }
    }
    setAttachments(next);
  };

  const removeAttachment = (target: File): void => {
    const url = previewUrlsRef.current.get(target);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current.delete(target);
    }
    setAttachments((cur) => cur.filter((f) => f !== target));
  };

  const clearAttachments = (): void => {
    for (const url of previewUrlsRef.current.values()) URL.revokeObjectURL(url);
    previewUrlsRef.current.clear();
    setAttachments([]);
    setAttachmentError(undefined);
  };

  // Revoke any lingering object URLs when the component unmounts.
  // Snapshot the Map at effect-mount so the cleanup uses that stable
  // reference instead of `previewUrlsRef.current` at unmount time
  // (the ref value can change in the meantime).
  useEffect(() => {
    const map = previewUrlsRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // Bash-shell-style prompt history. `historyIdx` is the index into
  // `history` (0 = most recent). `undefined` means "not in history
  // mode" (showing the user's draft). `historyDraft` stashes whatever
  // the user had typed BEFORE pressing Up, so Down past the newest
  // entry restores it instead of leaving the textarea blank.
  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  // localStorage tick — bumped after each pushInputHistory so the
  // memo recomputes and the new entry shows up on the next Up press
  // without needing a full re-render of the message list.
  const [historyTick, setHistoryTick] = useState(0);
  const history = useMemo(() => {
    // Merge the localStorage record (which captures slash commands +
    // bash exec + steers) with the message-derived history (which
    // captures regular prompts and survives across browser tabs /
    // sessionStorage clears). localStorage takes precedence because
    // it preserves exact submission order including non-LLM inputs;
    // message history backfills anything not yet persisted (e.g. a
    // session opened in a fresh tab where localStorage is empty).
    const persisted = readInputHistory(sessionId);
    const fromMessages = userHistory(messages);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const t of [...persisted, ...fromMessages]) {
      if (seen.has(t)) continue;
      seen.add(t);
      merged.push(t);
    }
    return merged;
    // historyTick is intentionally in the deps — bumping it
    // invalidates this memo when we push to localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId, historyTick]);
  const [historyIdx, setHistoryIdx] = useState<number | undefined>(undefined);
  const historyDraftRef = useRef<string>("");
  // Reset history navigation when the session changes — each session
  // has its own history stack.
  useEffect(() => {
    setHistoryIdx(undefined);
    historyDraftRef.current = "";
  }, [sessionId]);

  // Reset the double-Esc latch on session change so a stray Esc
  // logged against session A can't combine with a fresh Esc on
  // session B and abort the wrong run.
  useEffect(() => {
    lastEscRef.current = 0;
  }, [sessionId]);

  // Model selector state. We only know the user's chosen model client-side
  // (the SDK doesn't expose "current model" over REST), so persist the
  // last-applied selection in localStorage per session and re-apply when
  // the session changes. Empty string means "leave whatever the agent
  // has now." ChatInput is reused across sessions (no React key on the
  // mount), so we explicitly re-read storage on sessionId change instead
  // of relying on useState's mount-only initializer.
  const storageKey = MODEL_KEY_PREFIX + sessionId;
  const [providers, setProviders] = useState<ProvidersListing | undefined>(undefined);
  // The configured default in `settings.json` ({defaultProvider, defaultModel}).
  // Fetched once per mount; passed to ModelPicker so the "Use agent default"
  // row can name the actual model the agent would pick instead of just saying
  // "default". Undefined while loading; { provider: "", modelId: "" } if the
  // user hasn't set a default at all.
  const [defaultModel, setDefaultModel] = useState<
    { provider: string; modelId: string } | undefined
  >(undefined);
  const [modelChoice, setModelChoice] = useState<string>(
    () => localStorage.getItem(MODEL_KEY_PREFIX + sessionId) ?? "",
  );
  const [modelError, setModelError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void api
      .getProviders()
      .then(setProviders)
      .catch((err: unknown) => {
        // Surface as a non-fatal hint; chat still works with the default model.
        const code = err instanceof ApiError ? err.code : (err as Error).message;
        setModelError(`models unavailable (${code})`);
      });
    // settings.json — split fetch from providers because the picker UI
    // needs to render even when settings is empty / missing.
    void api
      .getSettings()
      .then((s) => {
        setDefaultModel({
          provider: typeof s.defaultProvider === "string" ? s.defaultProvider : "",
          modelId: typeof s.defaultModel === "string" ? s.defaultModel : "",
        });
      })
      .catch(() => {
        // Settings unreadable — keep defaultModel undefined; the picker
        // gracefully falls back to "Use agent default" with no name.
      });
  }, []);

  // On session change: re-read the per-session selection from storage and
  // re-apply it to the server-side AgentSession. Without this, the picker
  // would keep showing the previously-active session's model and the new
  // session would silently inherit its default. Skips the setModel call
  // when storage is empty (= "use whatever the session already has").
  useEffect(() => {
    const stored = localStorage.getItem(MODEL_KEY_PREFIX + sessionId) ?? "";
    setModelChoice(stored);
    setModelError(undefined);
    if (stored === "") return;
    const [provider, ...rest] = stored.split(":");
    const modelId = rest.join(":");
    if (provider === undefined || modelId.length === 0) return;
    // Capture the sessionId at call time so a slow setModel for session
    // A that resolves AFTER the user has switched to session B doesn't
    // surface its error toast on B (the wrong session). The .catch
    // gates setModelError on the captured id still being active.
    const callSessionId = sessionId;
    void api.setModel(callSessionId, provider, modelId).catch((err: unknown) => {
      if (callSessionId !== sessionId) return;
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setModelError(`set model failed: ${code}`);
    });
  }, [sessionId]);

  // Consume any pending input draft set by the session-tree's
  // edit-and-resubmit fork flow. One-shot: clear on the store side
  // so a remount of ChatInput doesn't re-apply it.
  const pendingDraft = useSessionStore((s) => s.pendingDraftBySession[sessionId]);
  const consumePendingDraft = useSessionStore((s) => s.consumePendingDraft);
  useEffect(() => {
    if (pendingDraft === undefined) return;
    setText(pendingDraft);
    consumePendingDraft(sessionId);
  }, [pendingDraft, sessionId, consumePendingDraft]);

  // Cross-component chat insert (e.g. file-browser "Add as @ context").
  // We append the requested text at the END of whatever the user has
  // typed, separated by a single space when needed so an existing token
  // doesn't fuse with the new one. Caret moves to the end so the user
  // can keep typing. Seq-gated so the same fragment doesn't double-fire
  // on re-renders.
  useEffect(() => {
    if (chatInsertRequest === undefined) return;
    if (chatInsertRequest.seq <= lastChatInsertSeqRef.current) return;
    lastChatInsertSeqRef.current = chatInsertRequest.seq;
    const insert = chatInsertRequest.text;
    setText((prev) => {
      if (prev.length === 0) return insert;
      const sep = /\s$/.test(prev) ? "" : " ";
      return `${prev}${sep}${insert}`;
    });
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta === null) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    });
    clearChatInsertRequest();
  }, [chatInsertRequest, clearChatInsertRequest]);

  const onModelChange = async (value: string): Promise<void> => {
    setModelChoice(value);
    if (value === "") {
      localStorage.removeItem(storageKey);
      return;
    }
    const [provider, ...rest] = value.split(":");
    const modelId = rest.join(":"); // model ids may contain ':'
    if (provider === undefined || modelId.length === 0) return;
    try {
      await api.setModel(sessionId, provider, modelId);
      localStorage.setItem(storageKey, value);
      setModelError(undefined);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setModelError(`set model failed: ${code}`);
    }
  };

  const submit = async (): Promise<void> => {
    const value = text.trim();
    // Allow empty text only when there's at least one attachment —
    // sending "look at this" with an image but no caption is a
    // common path. Server still rejects entirely-empty prompts.
    if ((value.length === 0 && attachments.length === 0) || submitting) return;
    // Record EVERY submission (slash command, bash exec, prompt,
    // steer) in the per-session input history so up-arrow recall
    // includes commands. Done up front so a slash command that
    // never returns from slashRunSelected still gets recorded.
    if (value.length > 0) {
      pushInputHistory(sessionId, value);
      setHistoryTick((t) => t + 1);
    }
    // /-command dispatch — the keyboard path (Enter) handles this
    // first, but a click on Send also lands here and a `/foo` typed
    // input shouldn't slip through to the LLM as a regular prompt.
    // Exception: pi prompt templates in `/<name> ...args` form bypass
    // dispatch — the SDK's `session.prompt()` expands them at send
    // time. See `isPromptInvocation` for the predicate.
    if (slashOpen && !isPromptInvocation) {
      if (slashFiltered.length > 0) {
        slashRunSelected();
      } else {
        setAttachmentError(
          `Unknown command "${text.split(/\s/)[0] ?? text}". Type /help to see commands.`,
        );
      }
      return;
    }
    setSubmitting(true);
    try {
      // Bash exec dispatch — `!cmd` includes the result in the next
      // turn's LLM context, `!!cmd` keeps it local-only. Both render
      // as a BashExecutionMessage in the transcript via the
      // server-side appendMessage path. Mirrors pi-tui semantics. We
      // refuse the dispatch while a session is streaming; running a
      // shell command mid-turn would race the agent's own bash tool
      // for stdin/cwd state and surprise the user.
      if (!isStreaming && /^!!?[^!]/.test(value)) {
        if (minimalUi) {
          setAttachmentError("Bash exec is disabled in this deployment.");
          return;
        }
        const excludeFromContext = value.startsWith("!!");
        const command = value.slice(excludeFromContext ? 2 : 1).trim();
        if (command.length === 0) {
          setAttachmentError("Empty bash command. Type something after the `!`.");
          return;
        }
        if (attachments.length > 0) {
          clearAttachments();
          setAttachmentError("Attachments aren't sent with `!` exec. Cleared.");
        }
        await api.exec(sessionId, command, { excludeFromContext });
        // The acting tab refetches via session-store's user_bash_result
        // handler too, but we trigger one directly so it lands without
        // waiting for the SSE round-trip from our own message.
        reloadMessages(sessionId);
        setText("");
        setHistoryIdx(undefined);
        historyDraftRef.current = "";
        return;
      }
      if (isStreaming) {
        // Steer doesn't accept attachments today — the SDK's steer()
        // takes (text, images?) which we COULD wire, but cleaner to
        // ship steer-with-text-only first. Clear immediately + warn
        // via the inline banner so the chips don't linger between
        // the warning and `sendSteer` resolving.
        if (attachments.length > 0) {
          clearAttachments();
          setAttachmentError("Attachments aren't sent on steer (mid-turn). Cleared.");
        }
        await sendSteer(sessionId, value);
      } else {
        await sendPrompt(sessionId, value, attachments.length > 0 ? attachments : undefined);
      }
      setText("");
      clearAttachments();
      // Submitting clears history mode — the user's prompt is now
      // (or will shortly be) the newest entry, and pressing Up next
      // should land on it from a fresh empty draft.
      setHistoryIdx(undefined);
      historyDraftRef.current = "";
    } catch (err) {
      // Surface bash-exec errors inline (api.exec throws ApiError on
      // 4xx/5xx). Other paths still surface via store.error below.
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setAttachmentError(`Command failed: ${code}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // ----- /-command palette keyboard handling -----
    // The palette is open whenever `slashOpen` is true (text starts
    // with `/`, no newline). Same key contract as the @-completion
    // popover.
    if (slashOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
      // The remaining nav/select keys only mean something when the
      // palette has at least one matching command. With zero matches
      // we let the keys fall through — Backspace can still erase
      // the `/` to drop out of palette mode and send the literal
      // text to the LLM.
      if (slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIdx((i) => Math.min(i + 1, slashFiltered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          // Pi-prompt invocation form (`/<knownname>` or
          // `/<knownname> ...args`) — fall through to the normal
          // Enter-submits path. Without this branch the Enter key
          // would re-fire the prompt entry's `run()` and clobber
          // any args the user typed.
          if (isPromptInvocation && e.key === "Enter" && !e.shiftKey) {
            // Don't preventDefault — let the regular Enter handler
            // below pick it up. (Tab still discovers / fills in.)
          } else {
            e.preventDefault();
            slashRunSelected();
            return;
          }
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Open palette + no matches + Enter: refuse rather than
        // silently sending the literal `/bogus` text to the LLM.
        e.preventDefault();
        setAttachmentError(
          `Unknown command "${text.split(/\s/)[0] ?? text}". Type /help to see commands, or backspace the leading / to send as a prompt.`,
        );
        return;
      }
    }
    // ----- @-completion popover keyboard handling -----
    // Take priority over the regular Enter-submits / arrow-history
    // paths when the popover is visible, so navigation + insert work
    // without sending the prompt by accident.
    const acOpen = acToken !== undefined && acSuggestions.length > 0;
    if (acOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcSelectedIdx((i) => Math.min(i + 1, acSuggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const pick = acSuggestions[acSelectedIdx];
        if (pick !== undefined) {
          e.preventDefault();
          acInsert(pick);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        acClose();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // Arrow-key history cycling — bash-shell style. Only intercepts
    // when entering history mode from an empty draft (Up) or while
    // already in history mode (either direction). Once the user
    // types after Up, `onChange` clears `historyIdx` and arrows
    // resume normal cursor movement.
    if (e.key === "ArrowUp") {
      const inHistory = historyIdx !== undefined;
      if (inHistory || text.length === 0) {
        if (history.length === 0) return;
        e.preventDefault();
        const nextIdx = inHistory ? Math.min((historyIdx ?? 0) + 1, history.length - 1) : 0;
        if (!inHistory) historyDraftRef.current = text;
        setHistoryIdx(nextIdx);
        const entry = history[nextIdx];
        if (entry !== undefined) setText(entry);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      if (historyIdx === undefined) return;
      e.preventDefault();
      if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        const entry = history[nextIdx];
        if (entry !== undefined) setText(entry);
      } else {
        // Past the newest → restore the user's draft from before
        // they started cycling history.
        setHistoryIdx(undefined);
        setText(historyDraftRef.current);
        historyDraftRef.current = "";
      }
      return;
    }
    if (e.key === "Escape") {
      // Only intercept Esc while the agent is running. When idle, let
      // it bubble — modals or other ancestors might want it. We also
      // skip the timestamp update when idle so a stray Esc logged on
      // an idle session can't combine with a fresh Esc moments later
      // when the session starts streaming.
      if (!isStreaming) return;
      e.preventDefault();
      const now = Date.now();
      const elapsed = now - lastEscRef.current;
      lastEscRef.current = now;
      if (elapsed < DOUBLE_ESC_WINDOW_MS) {
        lastEscRef.current = 0;
        void abortSession(sessionId);
      }
    }
  };

  // Wrap setText so any user-driven edit (typing, paste, programmatic
  // change from outside history) drops history mode. If the user
  // started navigating history and then started typing, subsequent
  // arrows should behave as ordinary cursor movement, not as more
  // history navigation.
  const handleTextChange = (next: string): void => {
    setText(next);
    if (historyIdx !== undefined) {
      setHistoryIdx(undefined);
      historyDraftRef.current = "";
    }
    // Re-evaluate the AC token at the new caret position. We don't
    // get the caret index from onChange directly; the textarea ref
    // has it in `selectionStart`. React batches state updates so the
    // textarea's caret has already moved by the time onChange fires.
    const caret = textareaRef.current?.selectionStart ?? next.length;
    const token = detectAcToken(next, caret);
    setAcToken(token);
    if (token === undefined) {
      setAcSuggestions([]);
    }
    // Reset the highlighted suggestion when the query changes — the
    // user typing more characters means the previous selection's
    // index might point at a now-irrelevant entry.
    setAcSelectedIdx(0);
  };

  /** Find the `@<query>` token that contains the caret, if any. */
  function detectAcToken(value: string, caret: number): AcToken | undefined {
    // Walk backward from the caret: the token is bounded by either
    // start-of-string or a whitespace char. If we hit whitespace
    // before finding an `@`, there's no token. If we hit an `@` whose
    // PREV char is start-of-string or whitespace, we've got one.
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === undefined) break;
      if (/\s/.test(ch)) return undefined;
      if (ch === "@") {
        const prev = i === 0 ? " " : value[i - 1];
        if (prev === undefined || /\s/.test(prev)) {
          return { start: i, end: caret, query: value.slice(i + 1, caret) };
        }
        return undefined; // `email@example.com` — not a marker
      }
      i -= 1;
    }
    return undefined;
  }

  // Debounced fetch of suggestions when the AC token changes.
  // Server's /files/complete is cheap (logLevel:warn keeps the
  // access logs clean), but we still debounce to avoid one fetch
  // per keystroke during fast typing. Discard stale responses via a
  // monotonic sequence counter.
  useEffect(() => {
    if (acToken === undefined || project === undefined) return undefined;
    const seq = acFetchSeqRef.current + 1;
    acFetchSeqRef.current = seq;
    const handle = window.setTimeout(() => {
      api
        .completeFiles(project.id, acToken.query, { limit: 20 })
        .then((r) => {
          if (acFetchSeqRef.current !== seq) return; // stale
          setAcSuggestions(r.paths);
          setAcSelectedIdx(0);
        })
        .catch(() => {
          if (acFetchSeqRef.current !== seq) return;
          setAcSuggestions([]);
        });
    }, 100);
    return () => window.clearTimeout(handle);
  }, [acToken, project]);

  /** Insert the highlighted suggestion in place of the partial token.
   *  Cursor lands at the end of the inserted path so the user can keep
   *  typing (often with a trailing space to start more text). */
  const acInsert = (path: string): void => {
    if (acToken === undefined) return;
    const before = text.slice(0, acToken.start);
    const after = text.slice(acToken.end);
    // Always wrap in double quotes. The quoted form lets users type
    // punctuation directly after the path (`@"src/foo.ts".`,
    // `@"src/foo.ts",`) — the bare form's `[^\s]+` rule would otherwise
    // greedy-match the trailing `.` or `,` as part of the filename and
    // break the reference. The quoted form is documented at
    // file-references.ts.
    const replacement = `@"${path}"`;
    const next = `${before}${replacement}${after}`;
    setText(next);
    setAcToken(undefined);
    setAcSuggestions([]);
    // Move caret to just after the inserted path. Wrap in
    // requestAnimationFrame so React's render cycle has updated the
    // textarea's value before we set the caret.
    const caret = before.length + replacement.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta === null) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  const acClose = (): void => {
    setAcToken(undefined);
    setAcSuggestions([]);
  };

  // `@<path>` references in the current draft. The badge row to the
  // right of the model picker shows the user (and any future
  // collaborator looking over the shoulder) exactly which files this
  // turn will reference. Removing the chip strips the matching
  // `@<path>` token from the input text.
  const fileRefs = parseChatFileReferences(text);

  const removeFileRef = (path: string): void => {
    const re = buildFileRefRegex(path);
    // Replace the match but PRESERVE the captured lead (start anchor
    // or whitespace) so the surrounding text isn't fused. Trim only
    // trailing whitespace so we don't strip a deliberate trailing
    // space the user typed.
    setText((prev) => prev.replace(re, (_match, lead: string) => lead).trimEnd());
  };

  return (
    <div className="bg-neutral-950">
      {/*
        Drag handle that lives where the composer's top border used to
        be. Plain visual: a 1-px hairline matching the rest of the
        chrome's border-neutral-800. On hover/active it brightens and
        the cursor flips to row-resize so the affordance is
        discoverable without taking up extra vertical space at rest.
        The 5-px hit area extends above the visual line so users don't
        have to pixel-hunt; `-translate-y` shifts the click region up
        without growing the layout box.
      */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat input"
        onPointerDown={startDividerDrag}
        className="group relative h-px cursor-row-resize bg-neutral-800 hover:bg-neutral-600 active:bg-neutral-500"
      >
        <div className="absolute inset-x-0 -top-1 h-2" />
      </div>
      <div className="mx-auto max-w-3xl space-y-2 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            providers={providers}
            defaultModel={defaultModel}
            value={modelChoice}
            onChange={(v) => void onModelChange(v)}
          />
          {fileRefs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {fileRefs.map((path, i) => (
                <span
                  key={`ref-${i}-${path}`}
                  className="inline-flex max-w-[220px] items-center gap-1 truncate rounded border border-emerald-700/60 bg-emerald-900/20 px-1.5 py-0.5 text-[11px] text-emerald-200"
                  title={`@${path} — model will use its read tool to load this file when it needs to`}
                >
                  <AtSign size={11} className="shrink-0" />
                  <span className="truncate font-mono">{path}</span>
                  <button
                    type="button"
                    onClick={() => removeFileRef(path)}
                    className="-mr-0.5 ml-0.5 rounded p-0.5 text-emerald-300/70 hover:bg-emerald-900/40 hover:text-emerald-100"
                    title={`Remove @${path}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {(modelError !== undefined || textareaHeight !== undefined) && (
            <div className="ml-auto flex items-center gap-2">
              {modelError !== undefined && (
                <span className="text-[11px] text-red-400">{modelError}</span>
              )}
              {textareaHeight !== undefined && (
                <button
                  type="button"
                  onClick={resetTextareaHeight}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Reset chat input height to default"
                  aria-label="Reset chat input height to default"
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          )}
        </div>
        {error !== undefined && <p className="text-xs text-red-400">Error: {error}</p>}
        {attachmentError !== undefined && (
          <p className="text-xs text-amber-400">{attachmentError}</p>
        )}
        {attachments.length > 0 && (
          <AttachmentPreview
            attachments={attachments}
            previewUrls={previewUrlsRef.current}
            onRemove={removeAttachment}
          />
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            // Accept everything; the server (and addAttachments above)
            // sort images vs text by MIME type. Restricting `accept`
            // here would block legitimate code-file extensions the
            // browser doesn't have a built-in MIME for.
            onChange={(e) => {
              if (e.target.files !== null) addAttachments(e.target.files);
              // Reset so re-selecting the same file fires onChange.
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting || isStreaming}
            className="self-stretch rounded-md border border-neutral-700 bg-neutral-900 px-2 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              isStreaming
                ? "Attachments aren't sent on steer (mid-turn). Wait for the current run to finish."
                : "Attach files (images go into model context; text files are prepended to the prompt)"
            }
          >
            <Paperclip size={14} />
          </button>
          <div className="relative flex-1">
            {/* /-command palette — opens whenever the input starts
                with `/` and has no newline. Listed top-to-bottom in
                catalog order; filtered by `slashQuery` (chars after
                the `/` up to the first whitespace). Disabled
                commands (e.g. /abort when not streaming) render
                grayed and don't accept Enter. */}
            {slashOpen && slashFiltered.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg">
                <div className="max-h-64 overflow-y-auto py-1">
                  {slashFiltered.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        if (!cmd.available) return;
                        setSlashSelectedIdx(i);
                        slashRunSelected();
                      }}
                      onMouseEnter={() => setSlashSelectedIdx(i)}
                      disabled={!cmd.available}
                      className={`block w-full px-3 py-1 text-left text-[12px] ${
                        i === slashSelectedIdx && cmd.available
                          ? "bg-neutral-800 text-neutral-100"
                          : "text-neutral-300 hover:bg-neutral-900/80"
                      } ${cmd.available ? "" : "opacity-40"}`}
                      title={
                        cmd.available
                          ? cmd.description
                          : `${cmd.description} — unavailable right now`
                      }
                    >
                      <span className="font-mono text-neutral-200">{cmd.name}</span>
                      <span className="ml-2 text-[10px] text-neutral-500">{cmd.description}</span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500">
                  ↑↓ navigate · Enter/Tab run · Esc cancel
                </div>
              </div>
            )}
            {/* @-completion popover — anchored above the textarea.
                Hidden when there's no @ token at the caret OR no
                matching files. Bottom-up listing so the highlighted
                item is closest to the input. */}
            {acToken !== undefined && acSuggestions.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg">
                <div className="max-h-64 overflow-y-auto py-1">
                  {acSuggestions.map((path, i) => (
                    <button
                      key={path}
                      onMouseDown={(ev) => {
                        // mouseDown (not click) so the textarea
                        // doesn't lose focus + close the popover
                        // before our handler fires.
                        ev.preventDefault();
                        acInsert(path);
                      }}
                      onMouseEnter={() => setAcSelectedIdx(i)}
                      className={`block w-full truncate px-3 py-1 text-left font-mono text-[12px] ${
                        i === acSelectedIdx
                          ? "bg-neutral-800 text-neutral-100"
                          : "text-neutral-300 hover:bg-neutral-900/80"
                      }`}
                      title={path}
                    >
                      {path}
                    </button>
                  ))}
                </div>
                <div className="border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500">
                  ↑↓ navigate · Enter/Tab insert · Esc close
                </div>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => {
                // Close on blur — but only on the next tick so a
                // mousedown on a popover item still fires its handler
                // first. mouseDown.preventDefault on the buttons
                // avoids the blur entirely in practice; this is
                // belt-and-suspenders for tab-out / click-out paths.
                setTimeout(() => {
                  if (textareaRef.current !== document.activeElement) acClose();
                }, 0);
              }}
              placeholder={
                isAutoRetrying
                  ? "Auto-retry in progress — your message will be queued and sent after the retry completes…"
                  : isStreaming
                    ? "Steer the agent (Enter to send, Shift+Enter for newline)…"
                    : minimalUi
                      ? "Ask pi (Enter to send, Shift+Enter for newline) — `/` runs commands, `@path` references files…"
                      : "Ask pi (Enter to send, Shift+Enter for newline) — `/` runs commands, `!` runs bash, `@path` references files…"
              }
              title={
                isAutoRetrying
                  ? "The agent is auto-retrying after a provider error. New messages are queued and delivered when the retry succeeds."
                  : undefined
              }
              rows={3}
              style={textareaHeight !== undefined ? { height: `${textareaHeight}px` } : undefined}
              className={`w-full resize-none rounded-md border bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none ${
                bangMode === "local"
                  ? "border-amber-500 focus:border-amber-400"
                  : bangMode === "context"
                    ? "border-emerald-500 focus:border-emerald-400"
                    : "border-neutral-700 focus:border-neutral-500"
              }`}
            />
            {bangMode !== undefined && (
              <span
                className={`pointer-events-none absolute right-2 top-2 select-none rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                  bangMode === "local"
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-emerald-500/15 text-emerald-300"
                }`}
                title={
                  bangMode === "local"
                    ? "!! — runs bash; output stays local (excluded from LLM context)"
                    : "! — runs bash; output is added to the next turn's LLM context"
                }
              >
                {bangMode === "local" ? "bash · local" : "bash · context"}
              </span>
            )}
          </div>
          {/*
            Two buttons: Send (always) + Abort (streaming only). Pi's
            SDK picks steer-vs-followUp natively when we POST /steer
            during a run — we don't try to second-guess it. Abort is
            its own button so it can't be hit by accident from a
            misclick on Send.
          */}
          <div className="flex flex-row gap-1">
            <button
              onClick={() => void submit()}
              disabled={(text.trim().length === 0 && attachments.length === 0) || submitting}
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                isStreaming
                  ? "Send (Pi queues at the next agent break — steer or follow-up depending on agent state)"
                  : "Send (Enter)"
              }
            >
              Send
            </button>
            {isStreaming && (
              <button
                onClick={() => void abortSession(sessionId)}
                className="rounded-md border border-red-700/50 px-3 py-2 text-sm text-red-300 hover:bg-red-900/20"
                title="Stop the agent (or press Esc twice in the textbox)"
              >
                Abort
              </button>
            )}
          </div>
        </div>
        {isStreaming && (
          <p className="text-[10px] text-neutral-600">
            Send queues at the next agent break — Pi picks steer or follow-up. Abort: stop the agent
            (or press Esc twice in the textbox).
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Searchable model picker. A flat <select> works for a dozen models but
 * collapses under OpenRouter's 200+ list; this is a typeahead combobox
 * with arrow-key navigation. Click the trigger to open, type to filter,
 * Enter or click to commit, Esc to close.
 */
function ModelPicker({
  providers,
  defaultModel,
  value,
  onChange,
}: {
  providers: ProvidersListing | undefined;
  /**
   * The configured default from `settings.json`. When present and
   * non-empty, the "Use agent default" row in the dropdown shows the
   * actual provider/model the agent would pick (so users don't have
   * to flip to Settings → Agent to find out). Undefined while
   * loading; both fields can be empty strings if no default has been
   * configured at all (rare on a working install).
   */
  defaultModel: { provider: string; modelId: string } | undefined;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = useMemo(() => flattenModels(providers), [providers]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (query.trim().length === 0) {
      // No query: keep insertion order (provider-grouped).
      return options;
    }
    const scored: { opt: ModelOption; score: number }[] = [];
    for (const opt of options) {
      const score = scoreOption(opt, query);
      if (score !== undefined) scored.push({ opt, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.opt);
  }, [options, query]);

  const selected = options.find((o) => o.value === value);
  // Resolved default label — used both in the trigger when no override
  // is set, and in the "Use agent default" row of the dropdown.
  // Empty if defaultModel hasn't loaded or no default is configured.
  const defaultLabel =
    defaultModel !== undefined &&
    defaultModel.provider.length > 0 &&
    defaultModel.modelId.length > 0
      ? `${defaultModel.provider} / ${defaultModel.modelId}`
      : "";
  const triggerLabel =
    selected !== undefined
      ? `${selected.provider} / ${selected.name}`
      : defaultLabel.length > 0
        ? `${defaultLabel} (default)`
        : "default model";

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapperRef.current === null) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Focus the input after the dropdown mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || listRef.current === null) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const commit = (idx: number): void => {
    if (idx === -1) {
      // "Use default" row.
      onChange("");
    } else {
      const opt = filtered[idx];
      if (opt === undefined) return;
      onChange(opt.value);
    }
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(activeIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={providers === undefined}
        className="flex max-w-[260px] items-center gap-1 truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-[11px] text-neutral-200 disabled:opacity-50"
        title="Override the model for this session (click to search)"
      >
        <span className="text-neutral-500">model:</span>
        <span className="truncate">{triggerLabel}</span>
        <span className="ml-1 text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[360px] rounded border border-neutral-700 bg-neutral-950 shadow-xl">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search provider or model…"
            className="w-full border-b border-neutral-800 bg-transparent px-3 py-2 text-xs text-neutral-100 outline-none"
          />
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            <button
              data-idx={-1}
              onMouseEnter={() => setActiveIdx(-1)}
              onClick={() => commit(-1)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                activeIdx === -1 ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
              }`}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span>Use agent default</span>
                {defaultLabel.length > 0 && (
                  <span className="truncate font-mono text-[10px] text-neutral-500">
                    {defaultLabel}
                  </span>
                )}
              </span>
              {value === "" && <span className="text-emerald-400">●</span>}
            </button>
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-neutral-500">
                No models match. Add an API key in Settings → Providers.
              </p>
            ) : (
              filtered.map((opt, i) => (
                <button
                  key={opt.value}
                  data-idx={i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => commit(i)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                    i === activeIdx ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
                  }`}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-neutral-500">{opt.provider}</span>
                    <span className="truncate font-mono">{opt.name}</span>
                  </span>
                  {opt.value === value && <span className="text-emerald-400">●</span>}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
            {filtered.length} of {options.length} models — ↑↓ to move, Enter to pick, Esc to close
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Strip of attached file pills above the textarea. Image attachments
 * render as 48px-square thumbnails (object-fit: cover); non-image
 * files render as a chip with the filename + size. Each pill has an
 * × that calls `onRemove` to drop just that one.
 *
 * The previewUrls Map is owned by the parent — we read from it but
 * never modify it here. Object URLs are revoked in the parent's
 * `removeAttachment` and `clearAttachments`.
 */
function AttachmentPreview({
  attachments,
  previewUrls,
  onRemove,
}: {
  attachments: File[];
  previewUrls: Map<File, string>;
  onRemove: (f: File) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((f, i) => {
        const isImage = f.type.startsWith("image/");
        const url = previewUrls.get(f);
        return (
          <div
            key={`${i}-${f.name}`}
            className="group relative flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 pr-1 text-xs text-neutral-200"
          >
            {isImage && url !== undefined ? (
              <img
                src={url}
                alt={f.name}
                className="h-12 w-12 shrink-0 rounded-l-md object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-l-md bg-neutral-800 text-neutral-400">
                {isImage ? <ImageIcon size={14} /> : <Paperclip size={12} />}
              </span>
            )}
            <span className="flex flex-col py-1 pl-1">
              <span className="max-w-[160px] truncate font-mono text-[11px]" title={f.name}>
                {f.name}
              </span>
              <span className="text-[10px] text-neutral-500">{formatBytes(f.size)}</span>
            </span>
            <button
              onClick={() => onRemove(f)}
              className="ml-1 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-300"
              title={`Remove ${f.name}`}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
