import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Activity,
  AtSign,
  Image as ImageIcon,
  ListChecks,
  Paperclip,
  RotateCcw,
  X,
} from "lucide-react";
import { api, ApiError, type ProvidersListing } from "../lib/api-client";
import { useIsMobile } from "../lib/use-is-mobile";
import { EMPTY_MESSAGES, useSessionStore, type AgentMessageLike } from "../store/session-store";
import { useActiveProject } from "../store/project-store";
import { useUiConfigStore } from "../store/ui-config-store";
import { useUiStore } from "../store/ui-store";
import { useComposerStore } from "../store/composer-store";
import { deriveCounts, selectTodoState, useTodoStore } from "../store/todo-store";
import { countRunning, selectProcesses, useProcessesStore } from "../store/processes-store";
import { extractClipboardImageFiles } from "../lib/clipboard-images";
import { isChatSubmitShortcut } from "../lib/chat-input-keys";
import { parseSkillInvocation } from "../lib/skill-command";
import { ProcessesPopover, TodosPopover } from "./InputPopovers";

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
  // file-references.ts. See that file for the rationale. For the draft
  // badge row, keep bare one-word mentions like `@alex` out of the UI;
  // quoted refs and path-shaped bare refs are explicit enough to badge.
  const re = /(?:^|\s)@(?:"([^"\n]+)"|([^\s]+?))(?=[?,;:!)\]]?(?:\s|$))/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const quoted = m[1];
    const bare = m[2];
    if (quoted !== undefined) {
      out.push(quoted);
    } else if (bare !== undefined && /[./\\]/.test(bare)) {
      out.push(bare);
    }
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
 * Desktop Enter submits, Shift+Enter inserts a newline, and
 * Cmd/Ctrl+Enter submits everywhere. The model selector lives alongside
 * in this same phase; attachments and token/cost display land in later phases.
 */
const DOUBLE_ESC_WINDOW_MS = 600;

export function ChatInput({ sessionId }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const isReadOnlyExternal = useSessionStore((s) =>
    Object.values(s.byProject).some((sessions) =>
      sessions.some(
        (session) => session.sessionId === sessionId && session.isExternalLive === true,
      ),
    ),
  );
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
  const requestScrollToBottom = useSessionStore((s) => s.requestScrollToBottom);
  const abortSession = useSessionStore((s) => s.abortSession);
  const error = useSessionStore((s) => s.error);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Todo toggle — appears in the top-right of the chat-input
  // header when the active session has at least one non-deleted
  // task. Clicking flips the global `todoPanelOpen` state in
  // ui-store; App.tsx auto-opens the right pane if collapsed and
  // renders the panel as a bottom strip of whatever tab is showing.
  const todoState = useTodoStore((s) => selectTodoState(s, sessionId));
  const todoCounts = deriveCounts(todoState);
  // todoPanelOpen drives the active-button highlight on desktop
  // (where the badge toggles the bottom-strip right-pane panel).
  // On mobile the popover replaces that interaction — the badge
  // opens the popover instead.
  const todoPanelOpen = useUiStore((s) => s.todoPanelOpen);
  const setTodoPanelOpen = useUiStore((s) => s.setTodoPanelOpen);

  // Processes badge — visible only when the session has ≥1 live
  // process. Click dispatches via ui-store; App.tsx auto-opens
  // the right pane (if collapsed) and switches the tab to
  // "processes". Distinct from the todo toggle (which owns its
  // own panel-open state) because processes already has a
  // dedicated right-pane tab — the badge is a shortcut to it.
  const sessionProcesses = useProcessesStore((s) => selectProcesses(s, sessionId));
  const runningProcesses = countRunning(sessionProcesses);
  const openProcessesTab = useUiStore((s) => s.openProcessesTab);

  // Popovers anchored to the chat-input footer badges. Each is a
  // small floating panel that shows the list directly, instead of
  // navigating away to the right-pane tab (which is often
  // collapsed on narrow viewports — mobile PWA in particular).
  // The popover's footer link is the way to reach the full panel
  // for deeper drill-down.
  const [processesPopoverOpen, setProcessesPopoverOpen] = useState(false);
  const [todosPopoverOpen, setTodosPopoverOpen] = useState(false);
  const processesButtonRef = useRef<HTMLButtonElement>(null);
  const todosButtonRef = useRef<HTMLButtonElement>(null);

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
  const isMobile = useIsMobile();

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
   * silently. Bounds: min 60 px (~2 rows), max 40 % viewport.
   */
  const HEIGHT_KEY = "pi-forge:chat-input-height";
  const DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO = 0.4;
  const MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO = 0.25;
  const heightBounds = (): { min: number; max: number } => ({
    min: 60,
    max: Math.floor(window.innerHeight * DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO),
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
  // Bumped by Settings → Prompts / Skills after every toggle so the slash
  // palette refetches without requiring a project switch or full reload.
  const promptsRefreshTrigger = useUiStore((s) => s.promptsRefreshTrigger);
  const skillsRefreshTrigger = useUiStore((s) => s.skillsRefreshTrigger);
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
  const [extensionCommands, setExtensionCommands] = useState<
    { name: string; description?: string }[]
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
  }, [project?.id, promptsRefreshTrigger]);

  /**
   * Skills loaded by the active live-session project. The server validates
   * against the live session again on invocation; this list only drives
   * discovery and exact slash-command dispatch in the palette.
   */
  const [availableSkills, setAvailableSkills] = useState<{ name: string; description: string }[]>(
    [],
  );
  useEffect(() => {
    if (project === undefined) {
      setAvailableSkills([]);
      return;
    }
    let cancelled = false;
    void api
      .listSkills(project.id)
      .then((res) => {
        if (cancelled) return;
        setAvailableSkills(
          res.skills
            .filter((skill) => skill.effective)
            .map((skill) => ({ name: skill.name, description: skill.description })),
        );
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, skillsRefreshTrigger]);

  // Extension commands are session-specific: packages and project settings
  // are resolved when the live SDK session is created. A failed lookup leaves
  // the built-in palette usable (for example while an old session is loading).
  useEffect(() => {
    let cancelled = false;
    void api
      .listExtensionCommands(sessionId)
      .then((res) => {
        if (!cancelled) setExtensionCommands(res.commands);
      })
      .catch(() => {
        if (!cancelled) setExtensionCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Quick-action prompt chips with `mode: "insert"` (and the "Use as
  // context" button on completed run cards) bridge through
  // composer-store: they set a `pendingInsert` keyed to a sessionId;
  // the matching ChatInput consumes it on mount/effect, appending to
  // the live textarea value and focusing. Scoped by sessionId so a
  // stale insert from a now-hidden session doesn't land in the
  // currently-mounted one.
  const pendingInsert = useComposerStore((s) => s.pendingInsert);
  const consumePendingInsert = useComposerStore((s) => s.consumePendingInsert);
  useEffect(() => {
    if (pendingInsert === undefined) return;
    if (pendingInsert.sessionId !== sessionId) return;
    setText((cur) => {
      // If the current draft is non-empty and doesn't end on a newline,
      // separate the inserted text with a blank line so the two
      // sections don't run together.
      if (cur.length === 0) return pendingInsert.text;
      const sep = cur.endsWith("\n") ? "" : "\n\n";
      return cur + sep + pendingInsert.text;
    });
    consumePendingInsert();
    // Defer focus to the next tick so the textarea has the new value
    // before the cursor moves to its end.
    setTimeout(() => {
      const el = textareaRef.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [pendingInsert, sessionId, consumePendingInsert]);

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
                  "@<path> references a project file (autocomplete from the popover); type \\@ for a literal @."
              : "/<cmd> runs a pi-forge command (compact, abort, settings, …). " +
                  "!cmd runs bash (output → next LLM context); !!cmd runs bash local-only. " +
                  "@<path> references a project file (autocomplete from the popover); type \\@ for a literal @.",
          );
        },
      },
    ];
    // SDK extension commands take precedence over pi-forge UI commands,
    // matching the SDK's own prompt dispatch. Selection fills the exact
    // invocation into the editor; submit then uses the ordinary prompt route
    // so the SDK can run the handler immediately, including while streaming.
    for (const command of [...extensionCommands].reverse()) {
      commands.unshift({
        name: `/${command.name}`,
        description: command.description ?? "Extension command",
        available: true,
        run: () => {
          const insert = `/${command.name} `;
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
    for (const skill of availableSkills) {
      commands.push({
        name: `/skill:${skill.name}`,
        description: skill.description,
        available: !isStreaming,
        run: () => {
          // Skills accept free-form additional instructions. Insert the exact
          // command so Enter routes it to the validated skill endpoint.
          const insert = `/skill:${skill.name} `;
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
    availableSkills,
    extensionCommands,
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
   * SDK extension commands use the same normal-submit path via
   * `isExtensionCommandInvocation` below.
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

  // Unlike the palette, exact known skill invocations may carry multiline
  // free-form instructions. Keep their dispatch independent of `slashOpen`,
  // which deliberately closes once the input contains a newline.
  const skillInvocation = useMemo(
    () => parseSkillInvocation(text, new Set(availableSkills.map((skill) => skill.name))),
    [text, availableSkills],
  );

  // The SDK parses extension commands using only a literal space as the
  // separator. Preserve that exact invocation contract: bypass the local
  // slash dispatcher and let the normal prompt endpoint call session.prompt.
  const isExtensionCommandInvocation = useMemo(() => {
    if (!slashOpen) return false;
    const spaceIndex = text.indexOf(" ");
    const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return extensionCommands.some((command) => command.name === name);
  }, [slashOpen, text, extensionCommands]);

  /**
   * Run the highlighted command. `overrideIdx` lets a tap handler
   * pass the row's index directly instead of going through React
   * state, which avoids a stale-state bug on touch: desktop relies
   * on `onMouseEnter` to update `slashSelectedIdx` before
   * `onMouseDown` fires, but a tap on a touchscreen has no enter
   * event — mouseDown fires immediately and `setSlashSelectedIdx`
   * (async) hasn't applied yet, so the read here returns whatever
   * was previously highlighted. Tap handlers MUST pass the index;
   * keyboard / Enter paths can omit it (state is already current).
   */
  const slashRunSelected = (overrideIdx?: number): void => {
    const idx = overrideIdx ?? slashSelectedIdx;
    const cmd = slashFiltered[idx];
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
  // Separate ref for the mobile-only image picker. Two inputs is
  // cleaner than swapping a single input's `accept` attribute, which
  // some browsers cache at element-mount and others don't.
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // Popover state for the mobile attach menu (Photo / File). Single
  // entry-point keeps the composer compact on phones — two buttons
  // would steal ~90 px of horizontal real estate from the textarea.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  // Auto-grown textarea metrics (px). Recomputed on every text change:
  // shrink to the configured floor, expand with scrollHeight, then cap
  // at either the user's manual pane height or a viewport-relative max
  // and allow internal scrolling past it.
  const [autoSize, setAutoSize] = useState<
    { height: number; maxHeight: number; overflowing: boolean } | undefined
  >(undefined);

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

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageFiles = extractClipboardImageFiles(e.clipboardData);
    if (imageFiles.length === 0) return;
    if (isReadOnlyExternal) {
      setAttachmentError("This pi-subagents child is running externally and is read-only.");
      return;
    }
    if (isStreaming) {
      setAttachmentError(
        "Images pasted while streaming aren't attached. Wait for the current run to finish.",
      );
      return;
    }
    // Do not preventDefault: when the clipboard contains both images
    // and text, the browser should still paste the text into the
    // textarea while we queue the image files as prompt attachments.
    addAttachments(imageFiles);
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
  // Per-session thinking-level mirror, sourced from the server (SDK
  // persists this as first-class session state in the JSONL, so we
  // don't keep a localStorage copy like we do for the model picker).
  // Undefined while the initial GET /sessions/:id is in flight or if
  // the call failed; the picker hides itself in that case.
  const [thinkingLevel, setThinkingLevel] = useState<string | undefined>(undefined);
  const [thinkingError, setThinkingError] = useState<string | undefined>(undefined);
  // The live AgentSession's actual active model, as reported by the
  // server (`session.model.provider` / `session.model.id`). Used as the
  // activeModel fallback when the user hasn't set a per-session
  // override. The settings.json `defaultModel` we fetched above is NOT
  // a substitute: it's empty when no global default is configured and
  // can point at a model the registry doesn't know about, both of which
  // would hide the thinking-level picker even though the SDK
  // definitely has SOME reasoning-capable model loaded. Undefined while
  // the initial GET /sessions/:id is in flight or if the call failed.
  const [activeSessionModel, setActiveSessionModel] = useState<
    { provider: string; modelId: string } | undefined
  >(undefined);

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
  // Also fetches the live session summary to pull the active thinking
  // level so the picker reflects on session switch.
  useEffect(() => {
    const stored = localStorage.getItem(MODEL_KEY_PREFIX + sessionId) ?? "";
    setModelChoice(stored);
    setModelError(undefined);
    setThinkingError(undefined);
    setThinkingLevel(undefined);
    setActiveSessionModel(undefined);
    // Pull the SDK-persisted thinking level + active model for this
    // session. Same captured-id pattern as the setModel call below — a
    // slow GET for session A that resolves after the user switched to
    // B mustn't overwrite B's state with A's values.
    {
      const callSessionId = sessionId;
      void api
        .getSession(callSessionId)
        .then((summary) => {
          if (callSessionId !== sessionId) return;
          setThinkingLevel(summary.thinkingLevel);
          if (summary.modelProvider !== undefined && summary.modelId !== undefined) {
            setActiveSessionModel({
              provider: summary.modelProvider,
              modelId: summary.modelId,
            });
          }
        })
        .catch(() => {
          // Disk-only or transient — leave thinkingLevel undefined so
          // the picker stays hidden until next switch / change.
        });
    }
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
      // The SDK's setModel calls setThinkingLevel internally to clamp
      // the active level against the new model's capabilities (e.g.
      // picking a non-reasoning model after running on "high" forces
      // the level to "off"). Refetch the summary so the picker
      // reflects whatever the SDK landed on. Also refresh
      // activeSessionModel so the lookup-key for the thinking picker
      // matches the SDK's new state (the optimistic modelChoice we
      // just set covers this too, but the server-canonical value
      // keeps both in sync after any clamp / fallback the SDK applies).
      const callSessionId = sessionId;
      void api
        .getSession(callSessionId)
        .then((summary) => {
          if (callSessionId !== sessionId) return;
          setThinkingLevel(summary.thinkingLevel);
          if (summary.modelProvider !== undefined && summary.modelId !== undefined) {
            setActiveSessionModel({
              provider: summary.modelProvider,
              modelId: summary.modelId,
            });
          }
        })
        .catch(() => {
          // Non-fatal: a stale picker is recoverable on next session
          // switch, and the underlying setModel already succeeded.
        });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setModelError(`set model failed: ${code}`);
    }
  };

  // Resolve which model the SDK is actually running for this session
  // and pull its entry from the providers listing so we can gate the
  // thinking-level picker on `reasoning`. Returns undefined while
  // providers/activeSessionModel are still loading OR when the active
  // model can't be found in the listing (e.g. settings.json points at
  // a removed model and the SDK fell back to a default the registry
  // doesn't know about) — in either case the picker stays hidden.
  //
  // Two sources, in priority order:
  //   1. modelChoice — per-session override the user just picked.
  //      Optimistic: takes effect before the setModel round-trip
  //      completes so the picker doesn't flicker mid-call.
  //   2. activeSessionModel — server-canonical
  //      session.model.provider/id, refreshed on session switch and
  //      after every setModel success.
  //
  // settings.json's defaultModel is NOT consulted here — it can be
  // empty (no global default set) or stale (points at a removed model)
  // while the SDK is happily running on its own compile-time fallback.
  // Falling back to it produced the bug where the picker disappeared
  // for default-model sessions even on reasoning-capable models.
  const activeModel = useMemo(() => {
    if (providers === undefined) return undefined;
    let provider: string;
    let modelId: string;
    if (modelChoice.length > 0) {
      const [p, ...rest] = modelChoice.split(":");
      if (p === undefined) return undefined;
      provider = p;
      modelId = rest.join(":");
    } else if (activeSessionModel !== undefined) {
      provider = activeSessionModel.provider;
      modelId = activeSessionModel.modelId;
    } else {
      return undefined;
    }
    const entry = providers.providers.find((p) => p.provider === provider);
    return entry?.models.find((m) => m.id === modelId);
  }, [providers, modelChoice, activeSessionModel]);

  const onThinkingLevelChange = async (level: string): Promise<void> => {
    // Optimistic — the SDK clamps so the response may differ; we
    // reconcile from the response body below.
    setThinkingLevel(level);
    try {
      const res = await api.setThinkingLevel(sessionId, level);
      setThinkingLevel(res.level);
      setThinkingError(undefined);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      setThinkingError(`set thinking level failed: ${code}`);
    }
  };

  const submit = async (): Promise<void> => {
    const rawValue = text;
    const value = rawValue.trim();
    // Allow empty text only when there's at least one attachment —
    // sending "look at this" with an image but no caption is a
    // common path. Server still rejects entirely-empty prompts.
    if (isReadOnlyExternal) {
      setAttachmentError("This pi-subagents child is running externally and is read-only.");
      return;
    }
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
    // Prompt templates and SDK extension commands use the normal prompt path;
    // exact known skill commands use the validated skill endpoint below.
    if (
      slashOpen &&
      !isPromptInvocation &&
      skillInvocation === undefined &&
      !isExtensionCommandInvocation
    ) {
      if (slashFiltered.length > 0) {
        slashRunSelected();
      } else {
        setAttachmentError(
          `Unknown command "${text.split(/\s/)[0] ?? text}". Type /help to see commands.`,
        );
      }
      return;
    }
    requestScrollToBottom(sessionId);
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
      if (skillInvocation !== undefined) {
        if (isStreaming) {
          setAttachmentError(
            "Skills cannot run while the agent is streaming. Wait for the current run to finish.",
          );
          return;
        }
        if (attachments.length > 0) {
          clearAttachments();
          setAttachmentError("Attachments aren't sent with skills. Cleared.");
        }
        await api.invokeSkill(sessionId, skillInvocation.name, skillInvocation.instructions);
      } else if (isStreaming && !isExtensionCommandInvocation) {
        // Steer doesn't accept attachments today — the SDK's steer()
        // takes (text, images?) which we COULD wire, but cleaner to
        // ship steer-with-text-only first. Clear immediately + warn
        // via the inline banner so the chips don't linger between
        // the warning and `sendSteer` resolving.
        if (attachments.length > 0) {
          clearAttachments();
          setAttachmentError("Attachments aren't sent on steer (mid-turn). Cleared.");
        }
        await sendSteer(sessionId, rawValue);
      } else {
        // Extension commands always use session.prompt(), not steer: the SDK
        // executes them immediately during streaming and preserves their
        // command-handler semantics.
        await sendPrompt(
          sessionId,
          rawValue,
          attachments.length > 0 ? attachments : undefined,
          !isExtensionCommandInvocation,
        );
      }
      setText("");
      clearAttachments();
      // Submitting clears history mode — the user's prompt is now
      // (or will shortly be) the newest entry, and pressing Up next
      // should land on it from a fresh empty draft.
      setHistoryIdx(undefined);
      historyDraftRef.current = "";
      // Mobile-only: dismiss the on-screen keyboard so the user
      // can read the streaming reply without the keyboard eating
      // half the viewport. Desktop keeps focus so the next prompt
      // can be typed without re-clicking.
      if (isMobile) textareaRef.current?.blur();
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
          // Prompt-template, skill, and SDK extension-command invocations
          // fall through to normal textarea handling on Enter. This preserves
          // typed arguments; Tab still discovers or fills commands in.
          if (
            (isPromptInvocation || skillInvocation !== undefined || isExtensionCommandInvocation) &&
            e.key === "Enter"
          ) {
            // Intentionally fall through.
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
      if ((e.key === "Enter" && e.metaKey !== true && e.ctrlKey !== true) || e.key === "Tab") {
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
    // Desktop plain Enter submits; Shift+Enter inserts a newline.
    // Mobile plain Enter still inserts a newline because virtual
    // keyboards do not expose Shift consistently; Cmd/Ctrl+Enter and
    // the Send button remain explicit submit paths everywhere.
    if (isChatSubmitShortcut(e, { isMobile })) {
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

  // Close the mobile attach popover on outside-click or Esc. The
  // file-input click-then-pick flow doesn't bounce focus back here,
  // so without an explicit close the popover would linger after the
  // picker dismisses. Single Event-typed handler covers mousedown +
  // touchstart so TS doesn't have to reconcile the per-event-name
  // overloads with a union handler signature.
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onPointerDown = (e: Event): void => {
      const root = attachMenuRef.current;
      if (root === null) return;
      if (root.contains(e.target as Node)) return;
      setAttachMenuOpen(false);
    };
    // `KeyboardEvent` is shadowed by React's type import at the top
    // of the file, so we can't write `(e: KeyboardEvent)` without
    // hitting React's overload. Read the key off the raw Event
    // instead — it's the same shape at runtime.
    const onKey: EventListener = (e) => {
      const key = (e as { key?: string }).key;
      if (key === "Escape") setAttachMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("touchstart", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  // Auto-grow the textarea on every input change. Collapse to "auto"
  // before measuring so deleting lines can shrink the box again; then
  // clamp to a sensible floor/ceiling. On desktop, a user-resized
  // composer is treated as the effective pane height (not just a
  // preferred minimum), so dragging the divider down can shrink a long
  // draft and make it scroll internally. Mobile keeps an even tighter
  // cap so the keyboard and transcript remain usable.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta === null) return;

    const prevHeight = ta.style.height;
    ta.style.height = "auto";
    const measured = ta.scrollHeight;
    ta.style.height = prevHeight;

    const manualMax = !isMobile ? textareaHeight : undefined;
    const floor = isMobile ? 44 : manualMax !== undefined ? 60 : 80;
    const viewportMax = Math.round(
      window.innerHeight *
        (isMobile ? MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO : DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO),
    );
    const max = Math.max(floor, manualMax ?? viewportMax);
    const height = manualMax !== undefined ? max : Math.max(floor, Math.min(measured, max));
    const overflowing = measured > height;
    const next = { height, maxHeight: max, overflowing };
    setAutoSize((cur) =>
      cur?.height === next.height &&
      cur.maxHeight === next.maxHeight &&
      cur.overflowing === next.overflowing
        ? cur
        : next,
    );
  }, [text, isMobile, textareaHeight]);

  return (
    <div className="forge-chat-input-root bg-neutral-950">
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
      {/* Drag-to-resize handle — hidden on mobile. Touch users have
          no use for cursor-row-resize, and a hidden 5-px hit area
          right above the textarea would intercept scroll gestures
          on phones. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat input"
        onPointerDown={startDividerDrag}
        className="group relative hidden h-px cursor-row-resize bg-neutral-800 hover:bg-neutral-600 active:bg-neutral-500 md:block"
      >
        <div className="absolute inset-x-0 -top-1 h-2" />
      </div>
      {/* Tighter padding on mobile so the composer hugs the bottom
          of the viewport (and the on-screen keyboard, when open).
          Bottom padding rides the safe-area inset so the composer
          sits above the iPhone home indicator / Android gesture bar
          instead of being clipped by them. Desktop keeps the
          original `px-6 py-3` breathing room. */}
      <div
        className="mx-auto max-w-3xl space-y-2 px-3 pt-2 md:px-6 md:py-3"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            providers={providers}
            defaultModel={defaultModel}
            value={modelChoice}
            onChange={(v) => void onModelChange(v)}
          />
          {activeModel !== undefined &&
            activeModel.supportedThinkingLevels.length > 1 &&
            thinkingLevel !== undefined && (
              <ThinkingLevelPicker
                value={thinkingLevel}
                options={activeModel.supportedThinkingLevels}
                onChange={(v) => void onThinkingLevelChange(v)}
              />
            )}
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
          {(modelError !== undefined ||
            thinkingError !== undefined ||
            textareaHeight !== undefined ||
            todoCounts.total > 0 ||
            runningProcesses > 0) && (
            <div className="ml-auto flex items-center gap-2">
              {modelError !== undefined && (
                <span className="text-[11px] text-red-400">{modelError}</span>
              )}
              {thinkingError !== undefined && (
                <span className="text-[11px] text-red-400">{thinkingError}</span>
              )}
              {/* Reset is paired with the drag handle; hide on
                  mobile since the handle is hidden there too and the
                  textarea ignores the persisted height. */}
              {!isMobile && textareaHeight !== undefined && (
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
              {/* Processes shortcut. Desktop: clicking opens the
                  right-pane Processes tab (auto-expands the pane
                  if collapsed via App.tsx). Mobile: clicking
                  opens a small floating popover anchored to the
                  button — the right pane is usually collapsed
                  there and routing to it would mean a full
                  navigation away from the chat input. The
                  popover's "Open full panel →" footer link
                  preserves access to the deeper view. */}
              {runningProcesses > 0 && (
                <div className="relative">
                  <button
                    ref={processesButtonRef}
                    type="button"
                    onClick={() => {
                      if (isMobile) setProcessesPopoverOpen((v) => !v);
                      else openProcessesTab();
                    }}
                    className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] ${
                      isMobile && processesPopoverOpen
                        ? "bg-neutral-800 text-neutral-100 light:bg-neutral-200 light:text-neutral-900"
                        : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 light:text-neutral-600 light:hover:bg-neutral-200 light:hover:text-neutral-900"
                    }`}
                    title={
                      isMobile
                        ? `${runningProcesses} background process(es) running — show list`
                        : `${runningProcesses} background process(es) running — view processes panel`
                    }
                    aria-label={isMobile ? "Show processes list" : "View processes panel"}
                    aria-expanded={isMobile ? processesPopoverOpen : undefined}
                  >
                    <Activity size={12} className="text-emerald-400 light:text-emerald-700" />
                    <span>{runningProcesses}</span>
                  </button>
                  {isMobile && (
                    <ProcessesPopover
                      open={processesPopoverOpen}
                      onClose={() => setProcessesPopoverOpen(false)}
                      anchorRef={processesButtonRef}
                      sessionId={sessionId}
                    />
                  )}
                </div>
              )}
              {/* Todo toggle. Desktop: clicking toggles the
                  bottom-strip todo panel in the right pane.
                  Mobile: clicking opens the popover with the
                  task list. Same rationale as processes — see
                  the comment above. */}
              {todoCounts.total > 0 && (
                <div className="relative">
                  <button
                    ref={todosButtonRef}
                    type="button"
                    onClick={() => {
                      if (isMobile) setTodosPopoverOpen((v) => !v);
                      else setTodoPanelOpen(!todoPanelOpen);
                    }}
                    className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] ${
                      (isMobile ? todosPopoverOpen : todoPanelOpen)
                        ? "bg-amber-900/40 text-amber-200 light:bg-amber-100 light:text-amber-900"
                        : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 light:text-neutral-600 light:hover:bg-neutral-200 light:hover:text-neutral-900"
                    }`}
                    title={
                      isMobile
                        ? `Tasks: ${todoCounts.completed}/${todoCounts.total} done${
                            todoCounts.inProgress > 0
                              ? `, ${todoCounts.inProgress} in progress`
                              : ""
                          }`
                        : todoPanelOpen
                          ? "Hide todo panel"
                          : `Show todo panel (${todoCounts.completed}/${todoCounts.total} done${
                              todoCounts.inProgress > 0
                                ? `, ${todoCounts.inProgress} in progress`
                                : ""
                            })`
                    }
                    aria-label={isMobile ? "Show tasks list" : "Toggle todo panel"}
                    aria-expanded={isMobile ? todosPopoverOpen : undefined}
                    aria-pressed={isMobile ? undefined : todoPanelOpen}
                  >
                    <ListChecks size={12} />
                    <span>
                      {todoCounts.completed}/{todoCounts.total}
                    </span>
                  </button>
                  {isMobile && (
                    <TodosPopover
                      open={todosPopoverOpen}
                      onClose={() => setTodosPopoverOpen(false)}
                      anchorRef={todosButtonRef}
                      sessionId={sessionId}
                    />
                  )}
                </div>
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
          {/* Files input — accepts everything. On desktop this is
              the only attach affordance (the file dialog handles
              browsing anywhere, including image folders, fine).
              On mobile it's the "any file" companion to the image
              button below. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files !== null) addAttachments(e.target.files);
              // Reset so re-selecting the same file fires onChange.
              e.target.value = "";
            }}
          />
          {/* Image input — mobile-only. `accept="image/*"` is what
              both iOS Safari and Android Chrome use to surface the
              gallery + camera picker. Reached from the attach
              popover below; the popover is what hides the two
              attach surfaces behind a single button so the composer
              keeps its width on a phone. */}
          {isMobile && (
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files !== null) addAttachments(e.target.files);
                e.target.value = "";
              }}
            />
          )}
          {/* Attach affordance.
              - Mobile: single Paperclip that opens a small popover
                with Photo + File entries (Slack/Discord style).
                One button = one tap target's worth of horizontal
                space, instead of the ~90 px two side-by-side
                buttons would steal from the textarea on a 360 px
                phone.
              - Desktop: the same Paperclip directly opens the
                file picker (no popover, since the desktop file
                dialog already handles browsing anywhere). */}
          {isMobile ? (
            <div className="relative" ref={attachMenuRef}>
              <button
                onClick={() => setAttachMenuOpen((o) => !o)}
                disabled={submitting || isStreaming || isReadOnlyExternal}
                aria-label="Attach"
                aria-expanded={attachMenuOpen}
                className="inline-flex min-h-11 min-w-11 items-center justify-center self-stretch rounded-md border border-neutral-700 bg-neutral-900 px-2 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  isStreaming
                    ? "Attachments aren't sent on steer (mid-turn)."
                    : "Attach a photo or a file"
                }
              >
                <Paperclip size={16} />
              </button>
              {attachMenuOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-1 flex flex-col overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg">
                  <button
                    onClick={() => {
                      imageInputRef.current?.click();
                      setAttachMenuOpen(false);
                    }}
                    className="flex min-h-11 items-center gap-2 px-3 text-left text-[14px] text-neutral-200 hover:bg-neutral-800"
                  >
                    <ImageIcon size={16} className="shrink-0 text-neutral-400" />
                    Photo
                  </button>
                  <button
                    onClick={() => {
                      fileInputRef.current?.click();
                      setAttachMenuOpen(false);
                    }}
                    className="flex min-h-11 items-center gap-2 border-t border-neutral-800 px-3 text-left text-[14px] text-neutral-200 hover:bg-neutral-800"
                  >
                    <Paperclip size={16} className="shrink-0 text-neutral-400" />
                    File
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting || isStreaming || isReadOnlyExternal}
              aria-label="Attach files"
              className="inline-flex items-center justify-center self-stretch rounded-md border border-neutral-700 bg-neutral-900 px-2 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                isStreaming
                  ? "Attachments aren't sent on steer (mid-turn). Wait for the current run to finish."
                  : "Attach files (images go into model context; text files are prepended to the prompt)"
              }
            >
              <Paperclip size={14} />
            </button>
          )}
          <div className="relative flex-1">
            {/* /-command palette — opens whenever the input starts
                with `/` and has no newline. Listed top-to-bottom in
                catalog order; filtered by `slashQuery` (chars after
                the `/` up to the first whitespace). Disabled
                commands (e.g. /abort when not streaming) render
                grayed and don't accept Enter. */}
            {slashOpen && slashFiltered.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg">
                {/* Taller list with more breathing room on mobile so
                    each item is a comfortable tap target. md:max-h-64
                    restores the desktop popover size. */}
                <div className="max-h-[60vh] overflow-y-auto py-1 md:max-h-64">
                  {slashFiltered.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        if (!cmd.available) return;
                        setSlashSelectedIdx(i);
                        // Pass `i` directly — see the slashRunSelected
                        // doc-comment for why state isn't safe here.
                        slashRunSelected(i);
                      }}
                      onMouseEnter={() => setSlashSelectedIdx(i)}
                      disabled={!cmd.available}
                      className={`block w-full px-3 py-2.5 text-left text-[14px] md:py-1 md:text-[12px] ${
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
                      {/* Stack name/description on phones — descriptions
                          are too wide to fit on one line at 360 px and
                          would either truncate or push the row taller
                          than its tap-target sweet spot. md:flex
                          restores the desktop side-by-side layout. */}
                      <div className="flex flex-col md:block">
                        <span className="font-mono text-neutral-200">{cmd.name}</span>
                        <span className="text-[12px] text-neutral-500 md:ml-2 md:text-[10px]">
                          {cmd.description}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                {/* Hint footer — keyboard hints aren't useful on a
                    touchscreen, hide on mobile to save vertical space. */}
                <div className="hidden border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500 md:block">
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
                <div className="max-h-[60vh] overflow-y-auto py-1 md:max-h-64">
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
                      className={`block w-full truncate px-3 py-2.5 text-left font-mono text-[14px] md:py-1 md:text-[12px] ${
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
                <div className="hidden border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500 md:block">
                  ↑↓ navigate · Enter/Tab insert · Esc close
                </div>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
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
                isReadOnlyExternal
                  ? "Read-only while this pi-subagents child is running externally…"
                  : isAutoRetrying
                    ? "Auto-retry in progress — your message will be queued and sent after the retry completes…"
                    : isStreaming
                      ? isMobile
                        ? "Steer the agent…"
                        : "Steer the agent (Enter to send; Shift+Enter for newline)…"
                      : isMobile
                        ? minimalUi
                          ? "Ask pi — Enter for newline; Send to submit; `/` runs commands, `@path` references files…"
                          : "Ask pi — Enter for newline; Send to submit; `/` runs commands, `!` runs bash, `@path` references files…"
                        : minimalUi
                          ? "Ask pi (Enter to send; Shift+Enter for newline) — `/` runs commands, `@path` references files…"
                          : "Ask pi (Enter to send; Shift+Enter for newline) — `/` runs commands, `!` runs bash, `@path` references files…"
              }
              title={
                isAutoRetrying
                  ? "The agent is auto-retrying after a provider error. New messages are queued and delivered when the retry succeeds."
                  : undefined
              }
              // Starts at a comfortable minimum (2 rows on mobile,
              // 3 on desktop), then auto-grows with the user's input.
              // Desktop drag-resize sets the effective pane height;
              // long drafts scroll internally once they exceed that
              // user-chosen size.
              rows={isMobile ? 2 : 3}
              disabled={isReadOnlyExternal}
              style={
                autoSize === undefined
                  ? undefined
                  : {
                      height: `${autoSize.height}px`,
                      maxHeight: `${autoSize.maxHeight}px`,
                      overflowY: autoSize.overflowing ? "auto" : "hidden",
                    }
              }
              className={`block w-full resize-none rounded-md border bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                // Match attach + send button min-height on mobile so
                // every child of the row renders at the same baseline
                // height. Without this the textarea collapses to its
                // intrinsic scrollHeight (~37 px when empty) and sits
                // visibly higher than the 44 px buttons.
                "min-h-11 md:min-h-0 "
              }${
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
            Send + Abort. On mobile they stack vertically (Abort
            above Send via flex-col-reverse, DOM order Send-then-
            Abort so desktop's `md:flex-row` reads correctly left-
            to-right). Crucially the wrapper is `self-stretch`, so
            its height matches the parent row's height (the auto-
            grown textarea). Each button takes `flex-1`, splitting
            that height evenly. Net result: composer overall height
            stays constant whether streaming or not — model picker
            row above doesn't shift when Abort appears.

            On desktop (md:) we revert to a row of natural-height
            buttons; the desktop composer is taller and there's
            plenty of room, so stretching looks weird there.
          */}
          <div className="flex flex-col-reverse gap-1 self-stretch md:flex-row md:items-end md:self-auto">
            <button
              onClick={() => void submit()}
              disabled={
                (text.trim().length === 0 && attachments.length === 0) ||
                submitting ||
                isReadOnlyExternal
              }
              className="flex-1 rounded-md bg-neutral-100 px-4 text-sm font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 md:flex-none md:py-2"
              title={
                isStreaming
                  ? "Send (Enter or Cmd/Ctrl+Enter; Pi queues at the next agent break — steer or follow-up depending on agent state)"
                  : "Send (Enter or Cmd/Ctrl+Enter)"
              }
            >
              Send
            </button>
            {isStreaming && (
              <button
                onClick={() => void abortSession(sessionId)}
                className="flex-1 rounded-md border border-red-700/60 bg-red-950/30 px-3 text-sm font-medium text-red-300 hover:bg-red-900/40 hover:text-red-100 md:flex-none md:py-2 light:border-red-700 light:bg-red-600 light:text-white light:hover:bg-red-700 light:hover:text-white"
                title="Stop the agent (or press Esc twice in the textbox)"
              >
                Abort
              </button>
            )}
          </div>
        </div>
        {isStreaming && (
          <p className="text-[10px] text-neutral-600">
            Enter, Cmd/Ctrl+Enter, or Send queues at the next agent break — Pi picks steer or
            follow-up. Abort: stop the agent (or press Esc twice in the textbox).
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
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
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
 * Per-session thinking-level picker rendered next to ModelPicker.
 * Only mounted when the active model has more than just `["off"]` in
 * its `supportedThinkingLevels` — gating happens at the parent (see
 * the conditional render in ChatInput), not inside this component,
 * so the picker doesn't render an "n/a" state for non-reasoning
 * models. Option list is the per-model array the server computed via
 * the SDK's `getSupportedThinkingLevels(model)` helper, so models
 * that expose `xhigh` get it and models that explicitly opt out of a
 * standard level (via a `null` entry in `thinkingLevelMap`) hide it.
 */
function ThinkingLevelPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapperRef.current === null) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-[11px] text-neutral-200"
        title="Override the thinking level for this session"
      >
        <span className="text-neutral-500">thinking:</span>
        <span className="truncate">{value}</span>
        <span className="ml-1 text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[140px] rounded border border-neutral-700 bg-neutral-950 shadow-xl">
          {options.map((level) => (
            <button
              key={level}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                level === value ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
              }`}
            >
              <span>{level}</span>
              {level === value && <span className="text-emerald-400">●</span>}
            </button>
          ))}
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
