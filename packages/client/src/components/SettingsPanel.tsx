import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  api,
  ApiError,
  type AuthSummary,
  type McpServerConfig,
  type McpServerStatus,
  type McpTransport,
  type ProvidersListing,
  type PromptSummary,
  type SkillDiagnostic,
  SERVER_THEME_COLOR_KEYS,
  type SandboxSettingsResponse,
  type ServerThemeColorKey,
  type ServerThemeColors,
  type ServerThemeConfigResponse,
  type SkillSummary,
  type ToolListing,
} from "../lib/api-client";
import { useActiveProject, useProjectStore } from "../store/project-store";
import { useUiConfigStore } from "../store/ui-config-store";
import { useUiStore } from "../store/ui-store";
import { EMPTY_STATUS, useMcpStore } from "../store/mcp-store";
import { useQuickActionsStore } from "../store/quick-actions-store";
import { THEME_DEFS, useThemeStore, type ThemeId } from "../lib/theme";
import { createClientId } from "../lib/client-id";
import { getStoredToken } from "../lib/auth-client";
import { WebhooksTab } from "./WebhooksTab";
import { useAuthStore } from "../store/auth-store";

type Tab =
  | "providers"
  | "agent"
  | "mcp"
  | "tools"
  | "sandbox"
  | "skills"
  | "prompts"
  | "systemPrompt"
  | "quickActions"
  | "webhooks"
  | "appearance"
  | "backup"
  | "general";

interface Props {
  onClose: () => void;
  /** Optional tab to land on when the panel opens (or re-opens). The
   *  slash-command palette uses this to route `/skills`, `/mcp`, etc.
   *  to the right tab. Honored on every change of value, so the
   *  parent can re-fire the same tab via a different render path. */
  initialTab?: Tab;
}

/**
 * Phase 8 settings UI. A modal-style overlay with three tabs:
 *
 *   - Providers — combined list from `GET /config/providers` (built-in
 *     models + anything in `models.json`). Each row has an "Add key" /
 *     "Replace key" / "Remove key" affordance against `auth.json`. Adding
 *     custom providers (vLLM/LiteLLM/Ollama) drops the user into a raw
 *     JSON editor — typed schema editing is deferred (DEFERRED.md Pol5).
 *
 *   - Agent — `settings.json` knobs: defaultProvider, defaultModel,
 *     defaultThinkingLevel. Sending `null` clears a key.
 *
 *   - Skills — per-project skill list from `GET /config/skills` with
 *     toggle. Requires an active project; surfaces a hint otherwise.
 *
 * Errors land in a banner at the top of the panel; per-tab spinners
 * reflect inflight loads. The panel is read-fresh on every open — no
 * cross-mount caching, since config is small and rarely changes.
 */
export function SettingsPanel({ onClose, initialTab }: Props) {
  const minimal = useUiConfigStore((s) => s.minimal);
  // Minimal mode hides Providers + Agent (those are configured at
  // the deploy level when MINIMAL_UI is set), so the default tab
  // shifts to Skills. Build the visible tab list from a single
  // source of truth so the buttons + the body branch can't drift.
  const visibleTabs = useMemo<readonly Tab[]>(
    () =>
      minimal
        ? // Tools stays visible in minimal — operators in locked-down
          // deployments often want to disable bash/edit/write at the
          // tool level, regardless of what providers / agent settings
          // are exposed.
          // Webhooks tab is intentionally OMITTED under MINIMAL_UI —
          // matches the server-side gate (POST/PATCH/DELETE/test
          // return 403). The view-only GET routes still exist but
          // there's nothing the operator can do from the UI; hiding
          // the tab avoids the dead surface.
          ([
            "skills",
            "prompts",
            "systemPrompt",
            "tools",
            "sandbox",
            "quickActions",
            "appearance",
            "backup",
            "general",
          ] as const)
        : ([
            "providers",
            "agent",
            "mcp",
            "tools",
            "sandbox",
            "skills",
            "prompts",
            "systemPrompt",
            "quickActions",
            "webhooks",
            "appearance",
            "backup",
            "general",
          ] as const),
    [minimal],
  );
  const [tab, setTab] = useState<Tab>(initialTab ?? (minimal ? "skills" : "providers"));
  // If the config flips after mount (rare but possible during hot-
  // reload in dev), pull the active tab back into the visible set.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab(visibleTabs[0]!);
  }, [visibleTabs, tab]);
  // External-tab-request: slash commands (`/skills`, `/mcp`, etc.)
  // open the panel via ui-store and pass the requested tab through
  // App. Re-fire on every change so opening to the same tab twice
  // still routes correctly.
  useEffect(() => {
    if (initialTab !== undefined && visibleTabs.includes(initialTab)) {
      setTab(initialTab);
    }
  }, [initialTab, visibleTabs]);
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // Width history: max-w-3xl (768px) → max-w-4xl (896px) when
        // the Prompts tab brought the count to 9 → max-w-6xl (1152px)
        // because the Quick Actions / MCP tabs render dense
        // multi-column forms that wrapped awkwardly at 896 → 88rem for
        // the v1.4.2 settings surface, which now has enough tabs and
        // wide form rows that 1152px can create an avoidable inner
        // scrollbar on desktop. Settings is a modal, so the extra
        // width doesn't compete with the chat for screen real estate;
        // `w-full` plus the overlay padding still clamps it on smaller
        // viewports.
        className="flex h-full max-h-[720px] w-full max-w-[88rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
          {/* Horizontally scrollable tab strip. With 10+ tabs the strip
              overflows on narrow viewports (mobile, small windows) —
              the modal itself is up to max-w-6xl but real-world phones
              clamp it to the viewport width. `min-w-0` lets the
              container actually shrink so `overflow-x-auto` activates;
              `shrink-0` on each tab keeps labels intact when the user
              scrolls. The trailing controls (API Docs / Close) stay
              fixed to the right via `gap-3` on the header. */}
          <div className="-mx-1 min-w-0 flex-1 overflow-x-auto px-1">
            <div className="flex min-w-max items-center gap-1">
              {visibleTabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`shrink-0 whitespace-nowrap rounded px-3 py-1 text-xs ${
                    tab === t
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                  }`}
                >
                  {t === "providers"
                    ? "Providers"
                    : t === "agent"
                      ? "Agent"
                      : t === "mcp"
                        ? "MCP"
                        : t === "tools"
                          ? "Tools"
                          : t === "sandbox"
                            ? "Sandbox"
                            : t === "skills"
                              ? "Skills"
                              : t === "prompts"
                                ? "Prompts"
                                : t === "systemPrompt"
                                  ? "System Prompt"
                                  : t === "quickActions"
                                    ? "Quick Actions"
                                    : t === "webhooks"
                                      ? "Webhooks"
                                      : t === "appearance"
                                        ? "Appearance"
                                        : t === "backup"
                                          ? "Backup"
                                          : "General"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => {
                // Carry the user's current token over to the swagger
                // UI page via a one-shot `?token=...` query param. The
                // server-side bootstrap (see swaggerThemeJs in
                // packages/server/src/index.ts) strips the token from
                // the URL on load and re-presents it as a Bearer
                // header on every API call from swagger UI. When auth
                // is disabled the token is absent and the page loads
                // unconditionally.
                const stored = getStoredToken();
                const url =
                  stored !== undefined
                    ? `/api/docs?token=${encodeURIComponent(stored.token)}`
                    : "/api/docs";
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
              title="Open the OpenAPI / Swagger UI in a new tab. Carries your auth token automatically."
            >
              API Docs ↗
            </button>
            <button
              onClick={onClose}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
              title="Close (Esc)"
            >
              Close
            </button>
          </div>
        </header>

        {error !== undefined && (
          <div className="border-b border-red-700/40 bg-red-900/20 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-neutral-200">
          {tab === "providers" && <ProvidersTab onError={setError} />}
          {tab === "agent" && <AgentTab onError={setError} />}
          {tab === "mcp" && <McpTab onError={setError} />}
          {tab === "tools" && <ToolsTab onError={setError} />}
          {tab === "sandbox" && <SandboxTab onError={setError} />}
          {tab === "skills" && <SkillsTab onError={setError} />}
          {tab === "prompts" && <PromptsTab onError={setError} />}
          {tab === "systemPrompt" && <SystemPromptTab onError={setError} />}
          {tab === "quickActions" && <QuickActionsTab onError={setError} />}
          {tab === "webhooks" && <WebhooksTab onError={setError} />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "backup" && <BackupTab onError={setError} />}
          {tab === "general" && <GeneralTab />}
        </div>
      </div>
    </div>
  );
}

function errorCode(err: unknown): string {
  return err instanceof ApiError ? err.code : (err as Error).message;
}

// ---------------- Providers tab ----------------

function ProvidersTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [providers, setProviders] = useState<ProvidersListing | undefined>(undefined);
  const [auth, setAuth] = useState<AuthSummary | undefined>(undefined);
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      const [p, a] = await Promise.all([api.getProviders(), api.getAuthSummary()]);
      setProviders(p);
      setAuth(a);
    } catch (err) {
      onError(`Failed to load providers: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async (provider: string): Promise<void> => {
    if (keyDraft.trim().length === 0) return;
    setBusy(true);
    try {
      await api.setApiKey(provider, keyDraft.trim());
      setEditingProvider(undefined);
      setKeyDraft("");
      await refresh();
    } catch (err) {
      onError(`Save key failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (provider: string): Promise<void> => {
    if (!confirm(`Remove the stored key for "${provider}"?`)) return;
    setBusy(true);
    try {
      await api.removeApiKey(provider);
      await refresh();
    } catch (err) {
      onError(`Remove key failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (providers === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading providers…</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Built-in providers and anything in <code className="font-mono">models.json</code>. Stored
        API keys are presence-only — actual values are never sent to the browser.
      </p>
      {providers.providers.length === 0 && (
        <p className="text-xs italic text-neutral-500">No providers configured.</p>
      )}
      {providers.providers.map((p) => {
        const presence = auth?.providers[p.provider];
        const configured = presence?.configured === true;
        const editing = editingProvider === p.provider;
        return (
          <div key={p.provider} className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-neutral-100">{p.provider}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                    configured
                      ? "bg-emerald-900/40 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
                      : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {configured ? "key set" : "no key"}
                </span>
                {presence?.source !== undefined && (
                  <span className="text-[10px] text-neutral-500">via {presence.source}</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs">
                {!editing && (
                  <button
                    onClick={() => {
                      setEditingProvider(p.provider);
                      setKeyDraft("");
                    }}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
                  >
                    {configured ? "Replace key" : "Add key"}
                  </button>
                )}
                {configured && !editing && (
                  <button
                    onClick={() => void removeKey(p.provider)}
                    disabled={busy}
                    className="rounded border border-red-700/50 px-2 py-0.5 text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {editing && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Paste API key"
                  autoFocus
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
                />
                <button
                  onClick={() => void saveKey(p.provider)}
                  disabled={busy || keyDraft.trim().length === 0}
                  className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingProvider(undefined);
                    setKeyDraft("");
                  }}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
                >
                  Cancel
                </button>
              </div>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-neutral-500 light:text-neutral-600">
                {p.models.length} model{p.models.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {p.models.map((m) => (
                  <li key={m.id} className="flex justify-between font-mono">
                    {/* hasAuth uses neutral-300 (dark text in dark theme,
                        readable in light after scale inversion). The "no
                        key" row uses neutral-600 in dark, which inverts
                        to near-white in light — explicitly bump that
                        path to a much darker shade for AA contrast. */}
                    <span
                      className={
                        m.hasAuth ? "text-neutral-300" : "text-neutral-600 light:text-neutral-400"
                      }
                    >
                      {m.name}
                    </span>
                    <span className="text-neutral-600 light:text-neutral-400">
                      ctx {Math.round(m.contextWindow / 1000)}k
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
      <CustomProvidersJson onError={onError} />
    </div>
  );
}

function CustomProvidersJson({ onError }: { onError: (msg: string | undefined) => void }) {
  // Raw-JSON editor for `models.json`. The dev plan calls for typed
  // forms per provider type (vLLM, LiteLLM, Ollama, OpenAI-compatible);
  // that's deferred to a follow-up. The raw editor is deliberately
  // gated behind a details dropdown so casual users don't see it.
  const [text, setText] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Transient post-save signal — clears after SAVE_FLASH_MS so the
  // banner doesn't linger as a stale "saved" claim once the user
  // edits again. Cleared synchronously on every new save attempt.
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  useSavedFlash(savedAt, () => setSavedAt(undefined));
  const load = async (): Promise<void> => {
    try {
      const m = await api.getModelsJson();
      setText(JSON.stringify(m, null, 2));
    } catch (err) {
      onError(`Load models.json failed: ${errorCode(err)}`);
    }
  };
  const save = async (): Promise<void> => {
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Surface as a typed error so the user sees what went wrong;
      // the JSON parser's exact message isn't useful for the operator.
      onError("models.json: invalid JSON");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { providers?: unknown }).providers !== "object" ||
      (parsed as { providers?: unknown }).providers === null
    ) {
      onError('models.json: top-level must be { "providers": { ... } }');
      return;
    }
    setBusy(true);
    setSavedAt(undefined);
    try {
      await api.setModelsJson(parsed as { providers: Record<string, unknown> });
      onError(undefined);
      setSavedAt(Date.now());
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <summary
        className="cursor-pointer text-xs text-neutral-300"
        onClick={() => {
          if (text === undefined) void load();
        }}
      >
        Custom providers (models.json)
      </summary>
      <p className="mt-1 text-[11px] text-neutral-500">
        Raw JSON editor. Add vLLM / LiteLLM / Ollama / OpenAI-compatible endpoints here. The SDK
        validates on next session creation.
      </p>
      {text === undefined ? (
        <p className="mt-2 text-xs italic text-neutral-500">Loading…</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={10}
            className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
          />
          <div className="mt-2 flex items-center justify-end gap-2 text-xs">
            {savedAt !== undefined && (
              <span className="text-emerald-400 light:text-emerald-700" aria-live="polite">
                Saved
              </span>
            )}
            <button
              onClick={() => void load()}
              disabled={busy}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300"
            >
              Reload
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded bg-neutral-100 px-3 py-1 font-medium text-neutral-900 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

// ---------------- Agent tab ----------------

function AgentTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [settings, setSettings] = useState<Record<string, unknown> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"form" | "json">("form");

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      const s = await api.getSettings();
      setSettings(s);
    } catch (err) {
      onError(`Failed to load settings: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const get = (key: string): string => {
    if (settings === undefined) return "";
    const v = settings[key];
    return typeof v === "string" ? v : "";
  };

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const next = await api.updateSettings(patch);
      setSettings(next);
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (settings === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading settings…</p>;
  }

  if (mode === "json") {
    return (
      <SettingsJsonEditor
        initial={settings}
        onSave={async (next) => {
          // Build a delta against the current settings so unset keys
          // become explicit `null` (delete) per the route's contract.
          const patch: Record<string, unknown> = { ...next };
          for (const key of Object.keys(settings)) {
            if (!(key in next)) patch[key] = null;
          }
          setBusy(true);
          try {
            const fresh = await api.updateSettings(patch);
            setSettings(fresh);
            onError(undefined);
          } catch (err) {
            onError(`Save failed: ${errorCode(err)}`);
            throw err;
          } finally {
            setBusy(false);
          }
        }}
        onSwitchToForm={() => setMode("form")}
        busy={busy}
        onError={onError}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          Defaults for new sessions. The form covers common keys; switch to JSON to edit anything
          the SDK accepts.
        </p>
        <button
          onClick={() => setMode("json")}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          Edit as JSON
        </button>
      </div>

      <Field label="Default provider" hint="e.g. anthropic, openai, google, custom">
        <TextSetting
          value={get("defaultProvider")}
          onSave={(v) => update({ defaultProvider: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Default model" hint="model id from the chosen provider">
        <TextSetting
          value={get("defaultModel")}
          onSave={(v) => update({ defaultModel: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>

      <Field label="Thinking level" hint="off, low, medium, high (provider-dependent)">
        <SelectSetting
          value={get("defaultThinkingLevel")}
          options={["", "off", "low", "medium", "high"]}
          onSave={(v) => update({ defaultThinkingLevel: v.length === 0 ? null : v })}
          disabled={busy}
        />
      </Field>
    </div>
  );
}

function SettingsJsonEditor({
  initial,
  onSave,
  onSwitchToForm,
  busy,
  onError,
}: {
  initial: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => Promise<void>;
  onSwitchToForm: () => void;
  busy: boolean;
  onError: (msg: string | undefined) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  useSavedFlash(savedAt, () => setSavedAt(undefined));

  const save = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Surface as a typed error; raw parser message isn't actionable.
      onError("settings.json: invalid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      onError("settings.json: top-level must be an object");
      return;
    }
    setSavedAt(undefined);
    try {
      await onSave(parsed as Record<string, unknown>);
      setSavedAt(Date.now());
    } catch {
      // onSave already routed the error to the panel banner
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-neutral-500">
          Raw <code className="font-mono">settings.json</code>. Keys removed here are deleted on
          save (mapped to <code className="font-mono">null</code> in the merge patch). The SDK
          validates on next session creation.
        </p>
        <button
          onClick={onSwitchToForm}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          Back to form
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={18}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
      />
      <div className="flex items-center justify-end gap-2 text-xs">
        {savedAt !== undefined && (
          <span className="text-emerald-400 light:text-emerald-700" aria-live="polite">
            Saved
          </span>
        )}
        <button
          onClick={() => setText(JSON.stringify(initial, null, 2))}
          disabled={busy}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300"
        >
          Reset
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1 font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Auto-clear a transient post-save indicator. The caller stores a
 * `Date.now()` timestamp on success; this hook clears it after a
 * fixed window so the "Saved" pill doesn't claim freshness on a
 * stale save the user has since edited away from.
 */
const SAVE_FLASH_MS = 2500;
function useSavedFlash(savedAt: number | undefined, clear: () => void): void {
  useEffect(() => {
    if (savedAt === undefined) return undefined;
    const id = window.setTimeout(clear, SAVE_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [savedAt, clear]);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-neutral-200">{label}</label>
      {hint !== undefined && <p className="text-[11px] text-neutral-500">{hint}</p>}
      {children}
    </div>
  );
}

function TextSetting({
  value,
  onSave,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void | Promise<void>;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <div className="flex items-center gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
      />
      <button
        onClick={() => void onSave(draft)}
        disabled={disabled || !dirty}
        className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function SelectSetting({
  value,
  options,
  onSave,
  disabled,
}: {
  value: string;
  options: string[];
  onSave: (v: string) => void | Promise<void>;
  disabled: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => void onSave(e.target.value)}
      className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o.length === 0 ? "(unset)" : o}
        </option>
      ))}
    </select>
  );
}

// ---------------- Skills tab ----------------

function SkillsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const project = useActiveProject();
  const projects = useProjectStore((s) => s.projects);
  const [skills, setSkills] = useState<SkillSummary[] | undefined>(undefined);
  /**
   * SDK-emitted warnings about skill files the loader rejected. The
   * most common case is a name collision when a top-level
   * `<dir>/foo.md` skill lacks `name:` frontmatter and falls back to
   * the parent dir name "skills" — silently colliding with another
   * file's identical fallback name. Without surfacing these the user
   * sees an authored skill go missing with no clue why.
   */
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  /** All per-project overrides, keyed by projectId. Used for the
   *  cascade view inside each expanded skill row. */
  const [allOverrides, setAllOverrides] = useState<
    Record<string, { enable: string[]; disable: string[] }>
  >({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    if (project === undefined) return;
    onError(undefined);
    try {
      const [{ skills: list, diagnostics: diags }, overrides] = await Promise.all([
        api.listSkills(project.id),
        api.listSkillOverrides(),
      ]);
      setSkills(list);
      setDiagnostics(diags);
      setAllOverrides(overrides.projects);
    } catch (err) {
      onError(`Failed to load skills: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (project === undefined) {
    return (
      <p className="text-xs italic text-neutral-500">
        Pick a project from the header to manage its skills.
      </p>
    );
  }

  if (skills === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading skills for {project.name}…</p>;
  }

  const toggleGlobal = async (name: string, next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const { skills: updated } = await api.setSkillEnabled(project.id, name, next, "global");
      setSkills(updated);
    } catch (err) {
      onError(`Toggle failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Set the override for `targetProjectId` to one of three states.
   *  `state === undefined` clears the override (= inherit from global). */
  const setProjectOverride = async (
    targetProjectId: string,
    name: string,
    state: "enabled" | "disabled" | undefined,
  ): Promise<void> => {
    setBusy(true);
    try {
      if (state === undefined) {
        await api.clearSkillProjectOverride(targetProjectId, name);
      } else {
        await api.setSkillEnabled(targetProjectId, name, state === "enabled", "project");
      }
      // Pull the canonical state for both the active project's
      // skills view AND the cascade map.
      await refresh();
    } catch (err) {
      onError(`Override write failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** State of a skill in some other project (for the cascade view). */
  const overrideStateFor = (
    targetProjectId: string,
    skillName: string,
  ): "enabled" | "disabled" | undefined => {
    const entry = allOverrides[targetProjectId];
    if (entry === undefined) return undefined;
    if (entry.enable.includes(skillName)) return "enabled";
    if (entry.disable.includes(skillName)) return "disabled";
    return undefined;
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        Skills discovered in <code className="font-mono">~/.pi/agent/skills/</code> and{" "}
        <code className="font-mono">{project.path}/.pi/skills/</code>. The global toggle writes to
        pi&apos;s <code className="font-mono">settings.skills</code>; per-project overrides write to
        the pi-forge-private file at{" "}
        <code className="font-mono">{`\${FORGE_DATA_DIR}/skills-overrides.json`}</code>.
      </p>
      <div className="rounded border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
        Skill changes apply to the <strong>next session</strong> you start in the affected project.
        Live sessions keep the skill set they booted with — start a new session to use a freshly
        enabled skill.
      </div>
      {diagnostics.length > 0 && <SkillDiagnosticsBanner diagnostics={diagnostics} />}
      {skills.length === 0 && (
        <p className="text-xs italic text-neutral-500">No skills found for this project.</p>
      )}
      {skills.map((s) => {
        const key = `${s.source}:${s.name}`;
        const isExpanded = expanded[key] === true;
        // Collect projects with explicit overrides for THIS skill —
        // shown in the cascade. The active project is included if it
        // has an override (so the user sees their own opinion in the
        // same UI as everyone else's).
        const overrideRows = projects
          .map((p) => ({
            project: p,
            state: overrideStateFor(p.id, s.name),
          }))
          .filter((r) => r.state !== undefined);
        const projectsWithoutOverride = projects.filter(
          (p) => overrideStateFor(p.id, s.name) === undefined,
        );
        return (
          <div key={key} className="rounded border border-neutral-800 bg-neutral-900/40">
            <div className="flex items-start gap-3 p-3">
              {/* Effective-state dot for the active project. */}
              <span
                className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-full ${
                  s.effective ? "bg-emerald-500" : "bg-neutral-700"
                }`}
                title={`Effective for ${project.name}: ${s.effective ? "enabled" : "disabled"}`}
              />
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-neutral-100">{s.name}</span>
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                    {s.source}
                  </span>
                  {s.projectOverride !== undefined && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                        s.projectOverride === "enabled"
                          ? "bg-emerald-900/40 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
                          : "bg-red-900/40 text-red-300 light:bg-red-100 light:text-red-800"
                      }`}
                      title={`Active project ('${project.name}') has an override`}
                    >
                      Project: {s.projectOverride}
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-400">{s.description || "(no description)"}</p>
                <p className="font-mono text-[10px] text-neutral-600">{s.filePath}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-xs">
                <button
                  onClick={() => void toggleGlobal(s.name, !s.enabled)}
                  disabled={busy}
                  className={`rounded border px-2 py-0.5 ${
                    s.enabled
                      ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                      : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
                  }`}
                  title="Global enable in pi's settings.skills"
                >
                  Global: {s.enabled ? "enabled" : "disabled"}
                </button>
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [key]: !isExpanded }))}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
                  title="Show per-project overrides"
                >
                  {isExpanded ? "▾ Overrides" : `▸ Overrides (${overrideRows.length})`}
                </button>
              </div>
            </div>
            {isExpanded && (
              <div className="border-t border-neutral-800 px-3 py-2">
                {overrideRows.length === 0 ? (
                  <p className="mb-2 text-[11px] italic text-neutral-500">
                    No project overrides yet — every project inherits the global state.
                  </p>
                ) : (
                  <div className="mb-2 space-y-1">
                    {overrideRows.map(({ project: p, state }) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 rounded bg-neutral-900/60 px-2 py-1 text-xs"
                      >
                        <span className="truncate text-neutral-200" title={p.path}>
                          {p.name}
                        </span>
                        <TriStatePicker
                          value={state}
                          disabled={busy}
                          onChange={(next) => void setProjectOverride(p.id, s.name, next)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {projectsWithoutOverride.length > 0 && (
                  <AddOverrideDropdown
                    projects={projectsWithoutOverride}
                    disabled={busy}
                    onAdd={(targetProjectId, state) =>
                      void setProjectOverride(targetProjectId, s.name, state)
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- Prompts tab ----------------

/**
 * Settings → Prompts. Mirrors `SkillsTab` end-to-end (see that for
 * detailed comments on the override / cascade pattern). Differences:
 *
 * - No "extension" source kind — pi prompts have no package-contributed
 *   path today, so every prompt is `global` or `project`.
 * - Surfaces the optional `argumentHint` from the prompt's frontmatter
 *   so users know what `/<promptname>` expects.
 * - Same diagnostics envelope (always empty server-side today, but
 *   plumbed for future SDK changes).
 *
 * Toggling enabled/disabled here doesn't INVOKE the prompt — that's
 * driven from the chat input's `/<promptname>` slash-command palette.
 * This tab is the management surface (which prompts exist on disk,
 * which are turned on for which projects).
 */
function PromptsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const project = useActiveProject();
  const projects = useProjectStore((s) => s.projects);
  const bumpPromptsRefresh = useUiStore((s) => s.bumpPromptsRefresh);
  const [prompts, setPrompts] = useState<PromptSummary[] | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [allOverrides, setAllOverrides] = useState<
    Record<string, { enable: string[]; disable: string[] }>
  >({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    if (project === undefined) return;
    onError(undefined);
    try {
      const [{ prompts: list, diagnostics: diags }, overrides] = await Promise.all([
        api.listPrompts(project.id),
        api.listPromptOverrides(),
      ]);
      setPrompts(list);
      setDiagnostics(diags);
      setAllOverrides(overrides.projects);
    } catch (err) {
      onError(`Failed to load prompts: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (project === undefined) {
    return (
      <p className="text-xs italic text-neutral-500">
        Pick a project from the header to manage its prompts.
      </p>
    );
  }

  if (prompts === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading prompts for {project.name}…</p>;
  }

  const toggleGlobal = async (name: string, next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const { prompts: updated } = await api.setPromptEnabled(project.id, name, next, "global");
      setPrompts(updated);
      // Tell the chat input to refetch its slash-palette so the
      // toggled prompt appears / disappears without a project switch.
      bumpPromptsRefresh();
    } catch (err) {
      onError(`Toggle failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setProjectOverride = async (
    targetProjectId: string,
    name: string,
    state: "enabled" | "disabled" | undefined,
  ): Promise<void> => {
    setBusy(true);
    try {
      if (state === undefined) {
        await api.clearPromptProjectOverride(targetProjectId, name);
      } else {
        await api.setPromptEnabled(targetProjectId, name, state === "enabled", "project");
      }
      await refresh();
      bumpPromptsRefresh();
    } catch (err) {
      onError(`Override write failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const overrideStateFor = (
    targetProjectId: string,
    promptName: string,
  ): "enabled" | "disabled" | undefined => {
    const entry = allOverrides[targetProjectId];
    if (entry === undefined) return undefined;
    if (entry.enable.includes(promptName)) return "enabled";
    if (entry.disable.includes(promptName)) return "disabled";
    return undefined;
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        Pi prompt templates discovered in <code className="font-mono">~/.pi/agent/prompts/</code>{" "}
        and <code className="font-mono">{project.path}/.pi/prompts/</code>. Invoke from the chat
        input via <code className="font-mono">/&lt;name&gt;</code>; the global toggle writes to
        pi&apos;s <code className="font-mono">settings.prompts</code>; per-project overrides write
        to <code className="font-mono">{`\${FORGE_DATA_DIR}/prompts-overrides.json`}</code>.
      </p>
      <div className="rounded border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
        Prompt changes apply to the <strong>next session</strong> you start in the affected project.
        Live sessions keep the prompt set they booted with — start a new session to use a freshly
        enabled prompt.
      </div>
      {diagnostics.length > 0 && <SkillDiagnosticsBanner diagnostics={diagnostics} />}
      {prompts.length === 0 && (
        <p className="text-xs italic text-neutral-500">No prompts found for this project.</p>
      )}
      {prompts.map((p) => {
        const key = `${p.source}:${p.name}`;
        const isExpanded = expanded[key] === true;
        const overrideRows = projects
          .map((proj) => ({ project: proj, state: overrideStateFor(proj.id, p.name) }))
          .filter((r) => r.state !== undefined);
        const projectsWithoutOverride = projects.filter(
          (proj) => overrideStateFor(proj.id, p.name) === undefined,
        );
        return (
          <div key={key} className="rounded border border-neutral-800 bg-neutral-900/40">
            <div className="flex items-start gap-3 p-3">
              <span
                className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-full ${
                  p.effective ? "bg-emerald-500" : "bg-neutral-700"
                }`}
                title={`Effective for ${project.name}: ${p.effective ? "enabled" : "disabled"}`}
              />
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-neutral-100">/{p.name}</span>
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                    {p.source}
                  </span>
                  {p.argumentHint !== undefined && (
                    <span
                      className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
                      title="Argument hint from the prompt's frontmatter"
                    >
                      {p.argumentHint}
                    </span>
                  )}
                  {p.projectOverride !== undefined && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                        p.projectOverride === "enabled"
                          ? "bg-emerald-900/40 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
                          : "bg-red-900/40 text-red-300 light:bg-red-100 light:text-red-800"
                      }`}
                      title={`Active project ('${project.name}') has an override`}
                    >
                      Project: {p.projectOverride}
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-400">{p.description || "(no description)"}</p>
                <p className="font-mono text-[10px] text-neutral-600">{p.filePath}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1 text-xs">
                <button
                  onClick={() => void toggleGlobal(p.name, !p.enabled)}
                  disabled={busy}
                  className={`rounded border px-2 py-0.5 ${
                    p.enabled
                      ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                      : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
                  }`}
                  title="Global enable in pi's settings.prompts"
                >
                  Global: {p.enabled ? "enabled" : "disabled"}
                </button>
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [key]: !isExpanded }))}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
                  title="Show per-project overrides"
                >
                  {isExpanded ? "▾ Overrides" : `▸ Overrides (${overrideRows.length})`}
                </button>
              </div>
            </div>
            {isExpanded && (
              <div className="border-t border-neutral-800 px-3 py-2">
                {overrideRows.length === 0 ? (
                  <p className="mb-2 text-[11px] italic text-neutral-500">
                    No project overrides yet — every project inherits the global state.
                  </p>
                ) : (
                  <div className="mb-2 space-y-1">
                    {overrideRows.map(({ project: proj, state }) => (
                      <div
                        key={proj.id}
                        className="flex items-center justify-between gap-2 rounded bg-neutral-900/60 px-2 py-1 text-xs"
                      >
                        <span className="truncate text-neutral-200" title={proj.path}>
                          {proj.name}
                        </span>
                        <TriStatePicker
                          value={state}
                          disabled={busy}
                          onChange={(next) => void setProjectOverride(proj.id, p.name, next)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {projectsWithoutOverride.length > 0 && (
                  <AddOverrideDropdown
                    projects={projectsWithoutOverride}
                    disabled={busy}
                    onAdd={(targetProjectId, state) =>
                      void setProjectOverride(targetProjectId, p.name, state)
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders SDK-emitted diagnostics — the loader's "I tried to load this
 * file but rejected it" warnings. Most user-actionable case is a name
 * collision: pi falls back to the parent dir name when no `name:` is
 * in the file's frontmatter, so multiple top-level `<dir>/*.md` skills
 * collide on the parent dir name and only the first one is loaded.
 * Surface enough context for the user to find and fix the offending
 * file without grepping through pi-mono source.
 */
function SkillDiagnosticsBanner({ diagnostics }: { diagnostics: SkillDiagnostic[] }) {
  return (
    <div className="space-y-1 rounded border border-red-700/40 bg-red-900/10 px-3 py-2 text-[11px] text-red-200">
      <p className="font-medium">
        {diagnostics.length} skill {diagnostics.length === 1 ? "file" : "files"} were not loaded:
      </p>
      <ul className="space-y-1.5">
        {diagnostics.map((d, i) => (
          <li key={i} className="border-l-2 border-red-700/60 pl-2">
            <div className="text-red-100">
              <span className="rounded bg-red-900/40 px-1 py-0.5 text-[10px] uppercase tracking-wider text-red-300">
                {d.type}
              </span>{" "}
              {d.message}
            </div>
            {d.collision !== undefined && (
              <div className="mt-0.5 font-mono text-[10px] text-red-300/80">
                <div>
                  loser:&nbsp;&nbsp;<span className="text-red-200">{d.collision.loserPath}</span>
                </div>
                <div>
                  winner:&nbsp;<span className="text-red-200">{d.collision.winnerPath}</span>
                </div>
                <div className="mt-1 text-red-300/70">
                  Add <code className="rounded bg-red-900/40 px-1">name: {`<unique>`}</code> to the
                  loser&apos;s frontmatter, or move it to{" "}
                  <code className="rounded bg-red-900/40 px-1">{`<unique>/SKILL.md`}</code> so the
                  parent dir name disambiguates.
                </div>
              </div>
            )}
            {d.collision === undefined && d.path !== undefined && (
              <div className="mt-0.5 font-mono text-[10px] text-red-300/80">{d.path}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TriStatePicker({
  value,
  disabled,
  onChange,
}: {
  value: "enabled" | "disabled" | undefined;
  disabled: boolean;
  onChange: (next: "enabled" | "disabled" | undefined) => void;
}) {
  const btn = (label: string, state: "enabled" | "disabled" | undefined, active: boolean) => (
    <button
      onClick={() => onChange(state)}
      disabled={disabled}
      className={`rounded px-2 py-0.5 text-[11px] ${
        active
          ? state === "enabled"
            ? "bg-emerald-900/40 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
            : state === "disabled"
              ? "bg-red-900/40 text-red-300 light:bg-red-100 light:text-red-800"
              : "bg-neutral-800 text-neutral-400"
          : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded border border-neutral-700 px-0.5">
      {btn("Inherit", undefined, value === undefined)}
      {btn("Enabled", "enabled", value === "enabled")}
      {btn("Disabled", "disabled", value === "disabled")}
    </div>
  );
}

function AddOverrideDropdown({
  projects,
  disabled,
  onAdd,
}: {
  projects: { id: string; name: string }[];
  disabled: boolean;
  onAdd: (projectId: string, state: "enabled" | "disabled") => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string>("");
  if (!pickerOpen) {
    return (
      <button
        onClick={() => setPickerOpen(true)}
        disabled={disabled}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
      >
        + Add override for…
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <select
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-neutral-100 outline-none focus:border-neutral-500"
      >
        <option value="">Pick project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          if (picked.length === 0) return;
          onAdd(picked, "enabled");
          setPickerOpen(false);
          setPicked("");
        }}
        disabled={disabled || picked.length === 0}
        className="rounded bg-emerald-900/40 px-2 py-0.5 text-emerald-300 disabled:opacity-50 light:bg-emerald-100 light:text-emerald-800"
      >
        Enable here
      </button>
      <button
        onClick={() => {
          if (picked.length === 0) return;
          onAdd(picked, "disabled");
          setPickerOpen(false);
          setPicked("");
        }}
        disabled={disabled || picked.length === 0}
        className="rounded bg-red-900/40 px-2 py-0.5 text-red-300 disabled:opacity-50"
      >
        Disable here
      </button>
      <button
        onClick={() => {
          setPickerOpen(false);
          setPicked("");
        }}
        className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 hover:border-neutral-500"
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------- Sandbox tab ----------------

interface SandboxEnvRow {
  id: string;
  name: string;
  value: string;
  revealed: boolean;
}

function sandboxRowsFromEnv(toolEnv: Record<string, string>): SandboxEnvRow[] {
  return Object.entries(toolEnv)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ id: createClientId("sandbox-env"), name, value, revealed: false }));
}

function sandboxRowsToEnv(rows: readonly SandboxEnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [idx, row] of rows.entries()) {
    const name = row.name.trim();
    if (name.length === 0 && row.value.length === 0) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Row ${idx + 1}: invalid environment variable name`);
    }
    out[name] = row.value;
  }
  return out;
}

function SandboxTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [settings, setSettings] = useState<SandboxSettingsResponse | undefined>(undefined);
  const [rows, setRows] = useState<SandboxEnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSandboxSettings()
      .then((res) => {
        if (cancelled) return;
        setSettings(res);
        setRows(sandboxRowsFromEnv(res.toolEnv));
        onError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError(errorCode(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaved(false);
    let parsed: Record<string, string>;
    try {
      parsed = sandboxRowsToEnv(rows);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateSandboxSettings(parsed);
      setSettings(res);
      setRows(sandboxRowsFromEnv(res.toolEnv));
      onError(undefined);
      setSaved(true);
    } catch (err) {
      onError(errorCode(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="space-y-4"
    >
      <div>
        <h2 className="text-sm font-semibold text-neutral-100">Sandbox mode</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Configure environment variables injected into future agent tool calls. Sandbox enablement,
          UID/GID, and tool HOME are deploy-time settings; changes here take effect for new or
          refreshed sessions.
        </p>
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-300">
        {loading ? (
          <span className="text-neutral-500">Loading sandbox settings…</span>
        ) : settings?.enabled ? (
          <span>
            Enabled{settings.uid !== undefined ? ` · uid ${settings.uid}` : ""}
            {settings.gid !== undefined ? ` · gid ${settings.gid}` : ""}
            {settings.home !== undefined ? ` · home ${settings.home}` : ""}
          </span>
        ) : (
          <span className="text-amber-300">
            Sandbox tool overrides are disabled. Saved variables are persisted, but only injected
            into forge-managed tool shells; full filesystem sandboxing requires
            AGENT_TOOL_SANDBOX_ENABLED=true.
          </span>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-neutral-300">Tool environment</span>
          <button
            type="button"
            onClick={() => {
              setRows((current) => [
                ...current,
                { id: createClientId("sandbox-env"), name: "", value: "", revealed: false },
              ]);
              setSaved(false);
            }}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
          >
            Add variable
          </button>
        </div>
        <div className="space-y-2">
          {rows.length === 0 && (
            <div className="rounded border border-dashed border-neutral-800 px-3 py-4 text-xs text-neutral-500">
              No sandbox tool environment variables configured.
            </div>
          )}
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 rounded border border-neutral-800 p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto]"
            >
              <input
                value={row.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setRows((current) => current.map((r) => (r.id === row.id ? { ...r, name } : r)));
                  setSaved(false);
                }}
                placeholder="HTTP_PROXY"
                spellCheck={false}
                className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 outline-none focus:border-neutral-600"
                aria-label="Environment variable name"
              />
              <input
                value={row.value}
                onChange={(e) => {
                  const value = e.target.value;
                  setRows((current) => current.map((r) => (r.id === row.id ? { ...r, value } : r)));
                  setSaved(false);
                }}
                type={row.revealed ? "text" : "password"}
                placeholder="value"
                spellCheck={false}
                autoComplete="off"
                className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 outline-none focus:border-neutral-600"
                aria-label="Environment variable value"
              />
              <button
                type="button"
                onClick={() =>
                  setRows((current) =>
                    current.map((r) => (r.id === row.id ? { ...r, revealed: !r.revealed } : r)),
                  )
                }
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
              >
                {row.revealed ? "Hide" : "Reveal"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRows((current) => current.filter((r) => r.id !== row.id));
                  setSaved(false);
                }}
                className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:border-red-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        Values are masked by default and only revealed per row. They are still stored in pi-forge
        data and passed to tool processes, so avoid secrets unless that storage is protected.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || saving}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save sandbox env"}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </form>
  );
}

// ---------------- Tools tab ----------------

/**
 * Per-tool enable / disable view for pi's seven built-in tools
 * (read / bash / edit / write / grep / find / ls). Each row is a
 * single toggle.
 *
 * MCP per-tool toggles live on the MCP tab as a cascade under each
 * server — keeping them next to the server's connection status,
 * URL, and master enable flag. Splitting the views lets each tab
 * focus: Tools = "what coding affordances does the agent have,"
 * MCP = "what external services is it connected to and which of
 * their tools are exposed."
 *
 * Allow-by-default. Disabling a tool removes it from the
 * `tools: [...]` allowlist passed to the next `createAgentSession`
 * — live sessions keep the tool set they booted with (same caveat
 * as every settings change today).
 */
function ToolsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const projects = useProjectStore((s) => s.projects);
  const [listing, setListing] = useState<ToolListing | undefined>(undefined);
  const [allOverrides, setAllOverrides] = useState<
    Record<
      string,
      {
        builtin: { enable: string[]; disable: string[] };
        mcp: { enable: string[]; disable: string[] };
        extension: { enable: string[]; disable: string[] };
      }
    >
  >({});
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    onError(undefined);
    try {
      // Listing here is global-only — the per-project state is
      // surfaced via the cascade panel inside each row, so we don't
      // need to re-fetch the listing on project switch.
      const [list, overrides] = await Promise.all([api.listTools(), api.listToolOverrides()]);
      setListing(list);
      setAllOverrides(overrides.projects);
    } catch (err) {
      onError(`Failed to load tools: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGlobal = async (
    family: "builtin" | "mcp" | "extension",
    name: string,
    nextEnabled: boolean,
  ): Promise<void> => {
    setBusy(true);
    try {
      await api.setToolEnabled(family, name, nextEnabled, "global");
      await refresh();
    } catch (err) {
      onError(`Toggle failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setProjectOverride = async (
    family: "builtin" | "mcp" | "extension",
    targetProjectId: string,
    name: string,
    state: "enabled" | "disabled" | undefined,
  ): Promise<void> => {
    setBusy(true);
    try {
      if (state === undefined) {
        await api.clearToolProjectOverride(family, name, targetProjectId);
      } else {
        await api.setToolEnabled(family, name, state === "enabled", "project", targetProjectId);
      }
      await refresh();
    } catch (err) {
      onError(`Override write failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (listing === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading tools…</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Toggle individual built-in tools the agent can call. The global toggle on the right is the
        default for every project. Use <strong>Overrides</strong> to enable/disable a tool per
        project — explicit project overrides win over the global default. Changes apply to the next
        session — already-running sessions keep the tool set they started with. MCP server tools
        live under their respective server in the <strong>MCP</strong> tab.
      </p>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Built-in tools
        </h3>
        <div className="space-y-2">
          {listing.builtin.map((t) => (
            <ToolCascadeRow
              key={`builtin:${t.name}`}
              family="builtin"
              name={t.name}
              fqn={t.name}
              description={t.description}
              globalEnabled={t.globalEnabled}
              projects={projects}
              allOverrides={allOverrides}
              busy={busy}
              onToggleGlobal={(next) => void toggleGlobal("builtin", t.name, next)}
              onSetProjectOverride={(projectId, state) =>
                void setProjectOverride("builtin", projectId, t.name, state)
              }
            />
          ))}
        </div>
      </section>

      {listing.extension.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Extension tools
          </h3>
          <p className="mb-2 text-[11px] text-neutral-500">
            Tools registered programmatically by pi extensions installed under{" "}
            <code className="font-mono">~/.pi/agent/extensions/</code> or a project's{" "}
            <code className="font-mono">.pi/extensions/</code>. Disabled tools are dropped from the
            allowlist passed to the next session — the extension itself remains loaded.
          </p>
          <div className="space-y-4">
            {listing.extension.map((ext) => (
              <div key={ext.packageSource} className="space-y-2">
                <div className="text-[11px] font-semibold text-neutral-300">
                  Package: <code className="font-mono text-neutral-400">{ext.packageSource}</code>
                </div>
                <div className="space-y-2">
                  {ext.tools.map((t) => (
                    <ToolCascadeRow
                      key={`extension:${ext.packageSource}:${t.name}`}
                      family="extension"
                      name={t.name}
                      fqn={t.name}
                      description={t.description}
                      globalEnabled={t.globalEnabled}
                      projects={projects}
                      allOverrides={allOverrides}
                      busy={busy}
                      onToggleGlobal={(next) => void toggleGlobal("extension", t.name, next)}
                      onSetProjectOverride={(projectId, state) =>
                        void setProjectOverride("extension", projectId, t.name, state)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One tool row with a global toggle + an "Overrides" expand button
 * that reveals the per-project cascade panel (tri-state picker for
 * each project that already has an override + an "Add override
 * for…" dropdown for projects that don't). Mirrors the Skills tab's
 * per-skill row exactly so the two tabs feel consistent.
 */
function ToolCascadeRow({
  family,
  name,
  fqn,
  description,
  globalEnabled,
  projects,
  allOverrides,
  busy,
  onToggleGlobal,
  onSetProjectOverride,
}: {
  family: "builtin" | "mcp" | "extension";
  /** Display name (short for MCP, bare for builtins). */
  name: string;
  /** Wire/storage name. For MCP this is the bridged
   *  `<server>__<tool>`; for builtins it equals `name`. */
  fqn: string;
  description: string;
  globalEnabled: boolean;
  projects: { id: string; name: string; path: string }[];
  allOverrides: Record<
    string,
    {
      builtin: { enable: string[]; disable: string[] };
      mcp: { enable: string[]; disable: string[] };
      extension: { enable: string[]; disable: string[] };
    }
  >;
  busy: boolean;
  onToggleGlobal: (next: boolean) => void;
  onSetProjectOverride: (projectId: string, state: "enabled" | "disabled" | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const overrideStateFor = (projectId: string): "enabled" | "disabled" | undefined => {
    const entry = allOverrides[projectId];
    if (entry === undefined) return undefined;
    const fam =
      family === "builtin" ? entry.builtin : family === "mcp" ? entry.mcp : entry.extension;
    // Defensive: an older server may return a project entry without
    // the `extension` key. Treat as "no override" rather than crash.
    if (fam === undefined) return undefined;
    if (fam.enable.includes(fqn)) return "enabled";
    if (fam.disable.includes(fqn)) return "disabled";
    return undefined;
  };
  const overrideRows = projects
    .map((p) => ({ project: p, state: overrideStateFor(p.id) }))
    .filter((r) => r.state !== undefined);
  const projectsWithoutOverride = projects.filter((p) => overrideStateFor(p.id) === undefined);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-start gap-3 p-3">
        <span
          className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-full ${
            globalEnabled ? "bg-emerald-500" : "bg-neutral-700"
          }`}
          title={`Global default: ${globalEnabled ? "enabled" : "disabled"}`}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-neutral-100">{name}</span>
            {fqn !== name && (
              <span
                className="font-mono text-[10px] text-neutral-500"
                title="Bridged tool name pi sees on the wire"
              >
                {fqn}
              </span>
            )}
          </div>
          {description.length > 0 && (
            <p className="line-clamp-2 text-[11px] text-neutral-500" title={description}>
              {description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          <button
            onClick={() => onToggleGlobal(!globalEnabled)}
            disabled={busy}
            className={`rounded border px-2 py-0.5 disabled:opacity-50 ${
              globalEnabled
                ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
            }`}
            title="Global default for every project that doesn't override"
          >
            Global: {globalEnabled ? "enabled" : "disabled"}
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
            title="Show per-project overrides"
          >
            {expanded ? "▾ Overrides" : `▸ Overrides (${overrideRows.length})`}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-neutral-800 px-3 py-2">
          {overrideRows.length === 0 ? (
            <p className="mb-2 text-[11px] italic text-neutral-500">
              No project overrides yet — every project inherits the global state.
            </p>
          ) : (
            <div className="mb-2 space-y-1">
              {overrideRows.map(({ project: p, state }) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded bg-neutral-900/60 px-2 py-1 text-xs"
                >
                  <span className="truncate text-neutral-200" title={p.path}>
                    {p.name}
                  </span>
                  <TriStatePicker
                    value={state}
                    disabled={busy}
                    onChange={(next) => onSetProjectOverride(p.id, next)}
                  />
                </div>
              ))}
            </div>
          )}
          {projectsWithoutOverride.length > 0 && (
            <AddOverrideDropdown
              projects={projectsWithoutOverride}
              disabled={busy}
              onAdd={(targetProjectId, state) => onSetProjectOverride(targetProjectId, state)}
            />
          )}
          {projects.length === 0 && (
            <p className="text-[11px] italic text-neutral-500">
              No projects exist yet. Create a project first to add per-project overrides.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- System Prompt tab ----------------

/**
 * Per-project addendum appended to the agent's base system prompt
 * via pi's `appendSystemPrompt` extension hook. Pi's base prompt
 * defines the tool-calling protocol — REPLACING it would break
 * tool use, so this surface is APPEND-only. Changes take effect on
 * the NEXT session created in the project; already-running sessions
 * keep the prompt they were built with.
 */
function SystemPromptTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const project = useActiveProject();
  const [addendum, setAddendum] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [maxBytes, setMaxBytes] = useState(20_000);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (project === undefined) {
      setAddendum(undefined);
      setDraft("");
      return;
    }
    let cancelled = false;
    onError(undefined);
    void (async () => {
      try {
        const res = await api.getProjectSystemPrompt(project.id);
        if (cancelled) return;
        setAddendum(res.addendum);
        setDraft(res.addendum);
        setMaxBytes(res.maxBytes);
      } catch (err) {
        if (cancelled) return;
        onError(`Failed to load system prompt: ${errorCode(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (project === undefined) {
    return (
      <p className="text-xs italic text-neutral-500">
        Pick a project from the header to edit its system prompt addendum.
      </p>
    );
  }
  if (addendum === undefined) {
    return (
      <p className="text-xs italic text-neutral-500">Loading system prompt for {project.name}…</p>
    );
  }

  const byteLen = new Blob([draft]).size;
  const overBudget = byteLen > maxBytes;
  const dirty = draft !== addendum;

  const save = async (): Promise<void> => {
    if (overBudget) return;
    setBusy(true);
    setSavedMsg(undefined);
    onError(undefined);
    try {
      const res = await api.setProjectSystemPrompt(project.id, draft);
      setAddendum(res.addendum);
      setDraft(res.addendum);
      setMaxBytes(res.maxBytes);
      setSavedMsg("Saved. Applies to the next session you start in this project.");
      window.setTimeout(() => setSavedMsg(undefined), 4_000);
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    if (!confirm(`Clear the system prompt addendum for "${project.name}"?`)) return;
    setBusy(true);
    setSavedMsg(undefined);
    onError(undefined);
    try {
      const res = await api.setProjectSystemPrompt(project.id, "");
      setAddendum(res.addendum);
      setDraft(res.addendum);
      setMaxBytes(res.maxBytes);
      setSavedMsg("Cleared. Applies to the next session you start in this project.");
      window.setTimeout(() => setSavedMsg(undefined), 4_000);
    } catch (err) {
      onError(`Clear failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1 text-xs text-neutral-400">
        <p>
          Free-form text appended to the agent's base system prompt for sessions in{" "}
          <strong className="text-neutral-200">{project.name}</strong>. Use this to layer
          project-specific behavior on top of pi's defaults — coding conventions, domain context,
          persona, etc.
        </p>
        <p className="text-[11px]">
          Append-only — the base prompt (which defines the tool-calling protocol) is not editable.
          Changes apply to the <strong>next session</strong> you start in this project; running
          sessions keep the prompt they were built with.
        </p>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={busy}
        rows={14}
        spellCheck={false}
        placeholder="e.g. This project uses TypeScript strict mode and never uses default exports. Always run `npm run check` before declaring a task complete."
        className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className={overBudget ? "text-red-400" : "text-neutral-500"}>
          {byteLen.toLocaleString()} / {maxBytes.toLocaleString()} bytes
          {overBudget && " — too long, please trim before saving"}
        </span>
        <div className="flex items-center gap-2">
          {savedMsg !== undefined && <span className="text-green-400">{savedMsg}</span>}
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft(addendum)}
              disabled={busy}
              className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600 disabled:opacity-50"
            >
              Revert
            </button>
          )}
          {addendum.length > 0 && (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={busy}
              className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-red-500 hover:text-red-300 disabled:opacity-50"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || overBudget || !dirty}
            className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Quick Actions tab ----------------

interface DraftAction {
  id?: string;
  name: string;
  kind: "command" | "prompt";
  enabled: boolean;
  command: string;
  timeoutSec: string;
  text: string;
  mode: "send" | "insert";
}

function emptyActionDraft(kind: "command" | "prompt"): DraftAction {
  return {
    name: "",
    kind,
    enabled: true,
    command: "",
    timeoutSec: "30",
    text: "",
    mode: "send",
  };
}

function QuickActionsTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const minimal = useUiConfigStore((s) => s.minimal);
  const loaded = useQuickActionsStore((s) => s.loaded);
  const actions = useQuickActionsStore((s) => s.actions);
  const load = useQuickActionsStore((s) => s.load);
  const create = useQuickActionsStore((s) => s.create);
  const update = useQuickActionsStore((s) => s.update);
  const remove = useQuickActionsStore((s) => s.remove);

  const [draft, setDraft] = useState<DraftAction | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onError(undefined);
    if (!loaded) void load();
  }, [load, loaded, onError]);

  const startEdit = (a: (typeof actions)[number]): void => {
    const isCmd = typeof a.command === "string" && a.command.length > 0;
    setDraft({
      id: a.id,
      name: a.name,
      kind: isCmd ? "command" : "prompt",
      enabled: a.enabled !== false,
      command: a.command ?? "",
      timeoutSec: String(Math.round((a.timeoutMs ?? 30_000) / 1000)),
      text: a.text ?? "",
      mode: a.mode ?? "send",
    });
  };

  const save = async (): Promise<void> => {
    if (draft === undefined) return;
    const trimmedName = draft.name.trim();
    if (trimmedName.length === 0) {
      onError("Name is required");
      return;
    }
    const body: {
      name: string;
      enabled?: boolean;
      command?: string;
      timeoutMs?: number;
      text?: string;
      mode?: "send" | "insert";
    } = { name: trimmedName, enabled: draft.enabled };
    if (draft.kind === "command") {
      const cmd = draft.command.trim();
      if (cmd.length === 0) {
        onError("Command is required");
        return;
      }
      body.command = cmd;
      const secs = Number.parseInt(draft.timeoutSec, 10);
      if (Number.isFinite(secs) && secs > 0) body.timeoutMs = secs * 1000;
    } else {
      const text = draft.text.trim();
      if (text.length === 0) {
        onError("Prompt text is required");
        return;
      }
      body.text = text;
      body.mode = draft.mode;
    }
    setBusy(true);
    try {
      if (draft.id === undefined) await create(body);
      else await update(draft.id, body);
      setDraft(undefined);
      onError(undefined);
    } catch (err) {
      onError(`Save failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await remove(id);
      setPendingDeleteId(undefined);
      if (draft?.id === id) setDraft(undefined);
    } catch (err) {
      onError(`Delete failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-100">Quick action chips</h2>
        <p className="mt-1 text-xs text-neutral-400">
          One-click buttons on the chat toolbar. Two kinds:{" "}
          <span className="text-amber-400 light:text-amber-700">command</span> chips run a shell
          snippet in the active project&apos;s folder;{" "}
          <span className="text-sky-400 light:text-sky-700">prompt</span> chips either send a
          templated prompt to the agent or insert it into the composer so you can tweak it before
          sending. Chips are stored globally (not per-project) — they&apos;re your personal toolbox.
        </p>
      </div>

      {minimal && (
        <div className="rounded border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
          MINIMAL_UI is enabled. Command chips are listed below but are hidden from the toolbar and
          the server refuses to run them. Prompt chips are unaffected.
        </div>
      )}

      <div className="space-y-1">
        {actions.length === 0 && loaded && (
          <p className="text-xs italic text-neutral-500">
            No chips defined yet. Click &ldquo;New&rdquo; below to add one.
          </p>
        )}
        {actions.map((a) => {
          const isCmd = typeof a.command === "string" && a.command.length > 0;
          const hiddenInMinimal = minimal && isCmd;
          return (
            <div
              key={a.id}
              className={`flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs light:border-neutral-300 light:bg-neutral-50 ${
                a.enabled === false ? "opacity-60" : ""
              }`}
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                  isCmd
                    ? "bg-amber-900/40 text-amber-300 light:bg-amber-100 light:text-amber-900"
                    : "bg-sky-900/40 text-sky-300 light:bg-sky-100 light:text-sky-900"
                }`}
              >
                {isCmd ? "cmd" : "prompt"}
              </span>
              <span className="flex-1 truncate font-medium text-neutral-200">{a.name}</span>
              {a.enabled === false && (
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                  disabled
                </span>
              )}
              {hiddenInMinimal && (
                <span className="text-[10px] uppercase tracking-wider text-amber-400 light:text-amber-700">
                  hidden by MINIMAL_UI
                </span>
              )}
              <button
                onClick={() => startEdit(a)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500 light:border-neutral-400"
              >
                Edit
              </button>
              {pendingDeleteId === a.id ? (
                <>
                  <button
                    onClick={() => void doDelete(a.id)}
                    disabled={busy}
                    className="rounded border border-red-700 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-900/40 light:border-red-400 light:text-red-700"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setPendingDeleteId(undefined)}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 light:border-neutral-400"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setPendingDeleteId(a.id)}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-500 hover:text-red-300 light:border-neutral-400"
                >
                  Delete
                </button>
              )}
            </div>
          );
        })}
      </div>

      {draft === undefined && (
        <button
          onClick={() => setDraft(emptyActionDraft("prompt"))}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 light:border-neutral-400"
        >
          + New chip
        </button>
      )}

      {draft !== undefined && (
        <div className="space-y-3 rounded border border-neutral-700 bg-neutral-900/60 p-3 light:border-neutral-300 light:bg-white">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
              Name
            </label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Run tests"
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 light:border-neutral-300 light:bg-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
              Kind
            </label>
            <div className="flex items-center gap-3 text-xs text-neutral-300">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={draft.kind === "prompt"}
                  onChange={() => setDraft({ ...draft, kind: "prompt" })}
                />
                Prompt
              </label>
              <label
                className={`flex items-center gap-1.5 ${minimal ? "opacity-50" : ""}`}
                title={
                  minimal
                    ? "Command chips are disabled by MINIMAL_UI. The server refuses to run them."
                    : undefined
                }
              >
                <input
                  type="radio"
                  checked={draft.kind === "command"}
                  disabled={minimal}
                  onChange={() => setDraft({ ...draft, kind: "command" })}
                />
                Command{minimal ? " (disabled by MINIMAL_UI)" : ""}
              </label>
            </div>
          </div>
          {draft.kind === "command" ? (
            <>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
                  Command
                </label>
                <textarea
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  rows={3}
                  placeholder="npm test"
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 light:border-neutral-300 light:bg-white"
                />
                <p className="mt-1 text-[11px] text-neutral-500">
                  Runs in the active project&apos;s folder via <code>/bin/sh -c</code>. Multi-line
                  is fine (<code>&amp;&amp;</code>, <code>;</code>, etc.). Environment is scrubbed
                  of pi-forge and provider secrets (same as the integrated terminal).
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
                  Timeout (seconds)
                </label>
                <input
                  value={draft.timeoutSec}
                  onChange={(e) => setDraft({ ...draft, timeoutSec: e.target.value })}
                  placeholder="30"
                  className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 light:border-neutral-300 light:bg-white"
                />
                <p className="mt-1 text-[11px] text-neutral-500">
                  Max 300 (five minutes). Past that, use the integrated terminal.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
                  Prompt text
                </label>
                <textarea
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  rows={4}
                  placeholder="Review the staged changes for security issues."
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 light:border-neutral-300 light:bg-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-400">
                  Mode
                </label>
                <div className="flex items-center gap-3 text-xs text-neutral-300">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      checked={draft.mode === "send"}
                      onChange={() => setDraft({ ...draft, mode: "send" })}
                    />
                    Send immediately
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      checked={draft.mode === "insert"}
                      onChange={() => setDraft({ ...draft, mode: "insert" })}
                    />
                    Insert into composer
                  </label>
                </div>
              </div>
            </>
          )}
          <div>
            <label className="flex items-center gap-1.5 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Enabled (visible in the menu)
            </label>
          </div>
          <div className="flex items-center gap-2 border-t border-neutral-800 pt-3 light:border-neutral-300">
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {draft.id === undefined ? "Create" : "Save"}
            </button>
            <button
              onClick={() => setDraft(undefined)}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500 light:border-neutral-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Appearance tab ----------------

function AppearanceTab() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const currentServerTheme = useUiConfigStore((s) => s.serverTheme);
  const setServerTheme = useUiConfigStore((s) => s.setServerTheme);
  const [serverThemeDraft, setServerThemeDraft] = useState<ServerThemeConfigResponse | undefined>(
    currentServerTheme,
  );
  const themeImportRef = useRef<HTMLInputElement>(null);
  const [baseThemeId, setBaseThemeId] = useState<ThemeId>(theme);
  const [serverThemeBusy, setServerThemeBusy] = useState(false);
  const [serverThemeError, setServerThemeError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .getServerTheme()
      .then((next) => {
        if (cancelled) return;
        setServerThemeDraft(next);
        setServerTheme(next);
        setServerThemeError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setServerThemeError(err instanceof ApiError ? err.code : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [setServerTheme]);

  const updateDraftColor = (key: ServerThemeColorKey, value: string): void => {
    setServerThemeDraft((prev) => {
      if (prev === undefined) return prev;
      return { ...prev, colors: { ...prev.colors, [key]: value } };
    });
  };

  const applyBaseTheme = (base: ThemeId): void => {
    setServerThemeDraft((prev) => {
      if (prev === undefined) return prev;
      return { ...prev, enabled: true, colors: SERVER_THEME_BASE_COLORS[base] };
    });
  };

  const exportServerTheme = (): void => {
    if (serverThemeDraft === undefined) return;
    const payload = {
      kind: "pi-forge-server-theme",
      version: 1,
      exportedAt: new Date().toISOString(),
      enabled: serverThemeDraft.enabled,
      colors: serverThemeDraft.colors,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pi-forge-theme.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importServerTheme = async (file: File): Promise<void> => {
    setServerThemeBusy(true);
    setServerThemeError(undefined);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const imported = parseImportedServerTheme(parsed, serverThemeDraft?.defaults);
      const saved = await api.updateServerTheme(imported);
      setServerThemeDraft(saved);
      setServerTheme(saved);
    } catch (err) {
      setServerThemeError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerThemeBusy(false);
      if (themeImportRef.current !== null) themeImportRef.current.value = "";
    }
  };

  const saveServerTheme = async (): Promise<void> => {
    if (serverThemeDraft === undefined) return;
    setServerThemeBusy(true);
    setServerThemeError(undefined);
    try {
      const saved = await api.updateServerTheme({
        enabled: serverThemeDraft.enabled,
        colors: serverThemeDraft.colors,
      });
      setServerThemeDraft(saved);
      setServerTheme(saved);
    } catch (err) {
      setServerThemeError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setServerThemeBusy(false);
    }
  };

  const resetServerTheme = async (): Promise<void> => {
    setServerThemeBusy(true);
    setServerThemeError(undefined);
    try {
      const reset = await api.resetServerTheme();
      setServerThemeDraft(reset);
      setServerTheme(reset);
    } catch (err) {
      setServerThemeError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setServerThemeBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Theme</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Sets the base color palette for the chrome, editor, and terminal. Persisted in this
            browser only — open in another browser to use a different base theme there.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEME_DEFS.map((def) => {
            const active = def.id === theme;
            return (
              <button
                key={def.id}
                onClick={() => setTheme(def.id)}
                className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-left ${
                  active
                    ? "border-neutral-400 bg-neutral-800"
                    : "border-neutral-700 hover:border-neutral-500"
                }`}
              >
                <div>
                  <div className="text-sm text-neutral-100">{def.label}</div>
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {def.mode}
                  </div>
                </div>
                <ThemeSwatch id={def.id} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 border-t border-neutral-800 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Global custom colors</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Server-side overrides for broad UI surfaces: app background, chat bubbles, text,
            highlights, and selection. Applies globally to every browser using this instance.
          </p>
        </div>
        {serverThemeError !== undefined && (
          <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {serverThemeError}
          </div>
        )}
        {serverThemeDraft === undefined ? (
          <p className="text-xs text-neutral-500">Loading custom colors…</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm text-neutral-200">
              <input
                type="checkbox"
                checked={serverThemeDraft.enabled}
                onChange={(e) =>
                  setServerThemeDraft((prev) =>
                    prev === undefined ? prev : { ...prev, enabled: e.target.checked },
                  )
                }
              />
              Enable global custom colors
            </label>
            <div className="flex flex-wrap items-end gap-2 rounded border border-neutral-800 bg-neutral-900/30 p-2">
              <label className="min-w-48 flex-1 text-xs text-neutral-400">
                Start from appearance
                <select
                  value={baseThemeId}
                  onChange={(e) => setBaseThemeId(e.target.value as ThemeId)}
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
                >
                  {THEME_DEFS.map((def) => (
                    <option key={def.id} value={def.id}>
                      {def.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => applyBaseTheme(baseThemeId)}
                disabled={serverThemeBusy}
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Copy colors
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SERVER_THEME_COLOR_KEYS.map((key) => (
                <ServerThemeColorField
                  key={key}
                  colorKey={key}
                  value={serverThemeDraft.colors[key]}
                  defaultValue={serverThemeDraft.defaults[key]}
                  onChange={(value) => updateDraftColor(key, value)}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void saveServerTheme()}
                disabled={serverThemeBusy}
                className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                Save custom colors
              </button>
              <button
                onClick={exportServerTheme}
                disabled={serverThemeBusy}
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Export theme
              </button>
              <button
                onClick={() => themeImportRef.current?.click()}
                disabled={serverThemeBusy}
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Import theme
              </button>
              <input
                ref={themeImportRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file !== undefined) void importServerTheme(file);
                }}
              />
              <button
                onClick={() => void resetServerTheme()}
                disabled={serverThemeBusy}
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const SERVER_THEME_LABELS: Record<ServerThemeColorKey, string> = {
  appBackground: "App background",
  panelBackground: "Panel background",
  userBubbleBackground: "User bubble",
  assistantBubbleBackground: "Assistant bubble",
  primaryText: "Text 1 — primary",
  secondaryText: "Text 2 — secondary",
  mutedText: "Text 3 — muted",
  highlightBackground: "Highlight background",
  highlightText: "Highlight text",
  selectionBackground: "Selection background",
};

const SERVER_THEME_BASE_COLORS: Record<ThemeId, ServerThemeColors> = {
  dark: {
    appBackground: "#0a0a0a",
    panelBackground: "#171717",
    userBubbleBackground: "#262626",
    assistantBubbleBackground: "#171717",
    primaryText: "#f5f5f5",
    secondaryText: "#d4d4d4",
    mutedText: "#a3a3a3",
    highlightBackground: "#facc15",
    highlightText: "#111827",
    selectionBackground: "#525252",
  },
  light: {
    appBackground: "#ffffff",
    panelBackground: "#f3f4f6",
    userBubbleBackground: "#e5e7eb",
    assistantBubbleBackground: "#f3f4f6",
    primaryText: "#171717",
    secondaryText: "#374151",
    mutedText: "#64748b",
    highlightBackground: "#fde68a",
    highlightText: "#78350f",
    selectionBackground: "#cbd5e1",
  },
  dracula: {
    appBackground: "#191a21",
    panelBackground: "#21222c",
    userBubbleBackground: "#2a2c3d",
    assistantBubbleBackground: "#21222c",
    primaryText: "#f8f8f2",
    secondaryText: "#c8c8c0",
    mutedText: "#9c9ca0",
    highlightBackground: "#ffb86c",
    highlightText: "#191a21",
    selectionBackground: "#44475a",
  },
  "solarized-dark": {
    appBackground: "#002b36",
    panelBackground: "#04212a",
    userBubbleBackground: "#052b36",
    assistantBubbleBackground: "#04212a",
    primaryText: "#eee8d5",
    secondaryText: "#93a1a1",
    mutedText: "#839496",
    highlightBackground: "#b58900",
    highlightText: "#002b36",
    selectionBackground: "#586e75",
  },
  "catppuccin-mocha": {
    appBackground: "#11111b",
    panelBackground: "#1e1e2e",
    userBubbleBackground: "#313244",
    assistantBubbleBackground: "#1e1e2e",
    primaryText: "#cdd6f4",
    secondaryText: "#9399b2",
    mutedText: "#7f849c",
    highlightBackground: "#f9e2af",
    highlightText: "#11111b",
    selectionBackground: "#585b70",
  },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function parseImportedServerTheme(
  input: unknown,
  fallbackDefaults: ServerThemeColors | undefined,
): { enabled: boolean; colors: ServerThemeColors } {
  const source = isObject(input) && isObject(input.colors) ? input.colors : input;
  if (!isObject(source)) throw new Error("Theme import must be a JSON object with colors.");
  const defaults = fallbackDefaults ?? SERVER_THEME_BASE_COLORS.dark;
  const colors = { ...defaults };
  for (const key of SERVER_THEME_COLOR_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isHexColor(value)) {
      throw new Error(`${SERVER_THEME_LABELS[key]} must be a 6-digit hex color like #0a0a0a.`);
    }
    colors[key] = value;
  }
  return {
    enabled: isObject(input) && typeof input.enabled === "boolean" ? input.enabled : true,
    colors,
  };
}

function ServerThemeColorField({
  colorKey,
  value,
  defaultValue,
  onChange,
}: {
  colorKey: ServerThemeColorKey;
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div>
        <div className="text-sm text-neutral-100">{SERVER_THEME_LABELS[colorKey]}</div>
        <div className="font-mono text-[10px] text-neutral-500">Default {defaultValue}</div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isHexColor(value) ? value : defaultValue}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern="^#[0-9a-fA-F]{6}$"
          className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100"
        />
      </div>
    </label>
  );
}

/**
 * Live swatch for a theme — applies that theme's `data-theme` to a
 * scoped wrapper so the four neutral steps below render in the
 * theme's actual palette without affecting the rest of the app.
 */
function ThemeSwatch({ id }: { id: ThemeId }) {
  return (
    <div data-theme={id} className="flex h-6 overflow-hidden rounded border border-neutral-700">
      <div className="w-4 bg-neutral-950" />
      <div className="w-4 bg-neutral-800" />
      <div className="w-4 bg-neutral-500" />
      <div className="w-4 bg-neutral-200" />
    </div>
  );
}

// ---------------- Backup tab ----------------

/**
 * Export / import the pi-forge's portable config as a `.tar.gz`.
 *
 * Export bundles `mcp.json` + `settings.json` + `models.json` +
 * `skills-overrides.json` + `tool-overrides.json`. Auth is
 * deliberately excluded (provider keys / OAuth tokens), and the
 * UI calls that out so a user planning a migration knows to re-auth
 * providers afterwards.
 *
 * Import is one-shot: the user picks a file, we POST it as multipart,
 * the server validates ALL files before any disk write, and we
 * surface the per-file summary. On success the user is reminded that
 * a fresh agent session is needed for the new config to take effect
 * (existing live sessions hold their settings/skills snapshot from
 * `createAgentSession` time — same caveat as every other settings
 * edit).
 */
function BackupTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const [lastExport, setLastExport] = useState<{ filename: string; files: string[] } | undefined>(
    undefined,
  );
  const [lastImport, setLastImport] = useState<
    | {
        imported: string[];
        skipped: string[];
        errors: { file: string; reason: string }[];
      }
    | undefined
  >(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Skills export / import state. Kept separate from the config
  // export/import state above so each section's "last result" message
  // doesn't bleed into the other.
  const [lastSkillsExport, setLastSkillsExport] = useState<
    { filename: string; fileCount: number } | undefined
  >(undefined);
  const [lastSkillsImport, setLastSkillsImport] = useState<
    | {
        imported: string[];
        skipped: { name: string; reason: string }[];
      }
    | undefined
  >(undefined);
  const skillsTarInputRef = useRef<HTMLInputElement>(null);
  const skillsFolderInputRef = useRef<HTMLInputElement>(null);

  const onExport = async (): Promise<void> => {
    onError(undefined);
    setBusy(true);
    setLastImport(undefined);
    try {
      const { blob, filename, files } = await api.exportConfig();
      // Trigger the browser download via a synthetic anchor click.
      // createObjectURL + revoke on the next animation frame avoids the
      // race where revoking inside the same task can cancel the
      // download in some browsers.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      requestAnimationFrame(() => URL.revokeObjectURL(url));
      setLastExport({ filename, files });
    } catch (err) {
      onError(`Export failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onImport = async (file: File): Promise<void> => {
    onError(undefined);
    setBusy(true);
    setLastExport(undefined);
    try {
      const summary = await api.importConfig(file);
      setLastImport(summary);
    } catch (err) {
      onError(`Import failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const triggerDownload = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    requestAnimationFrame(() => URL.revokeObjectURL(url));
  };

  const onExportSkills = async (): Promise<void> => {
    onError(undefined);
    setBusy(true);
    setLastSkillsImport(undefined);
    setLastSkillsExport(undefined);
    try {
      const { blob, filename, fileCount } = await api.exportSkills();
      triggerDownload(blob, filename);
      setLastSkillsExport({ filename, fileCount });
    } catch (err) {
      // Empty-skills is the most common reason this fails on a fresh
      // install — surface it as an info message via the result slot
      // (`fileCount: 0`) instead of a red error banner. Other errors
      // keep the generic banner.
      if (err instanceof ApiError && err.code === "skills_directory_empty") {
        setLastSkillsExport({ filename: "", fileCount: 0 });
      } else {
        onError(`Skills export failed: ${errorCode(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onImportSkills = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    onError(undefined);
    setBusy(true);
    setLastSkillsExport(undefined);
    try {
      const summary = await api.importSkills(files);
      setLastSkillsImport(summary);
    } catch (err) {
      onError(`Skills import failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
      if (skillsTarInputRef.current) skillsTarInputRef.current.value = "";
      if (skillsFolderInputRef.current) skillsFolderInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-100">Export config</h3>
        <p className="mb-3 text-xs text-neutral-400">
          Downloads a <code className="font-mono">.tar.gz</code> with{" "}
          <code className="font-mono">mcp.json</code>,{" "}
          <code className="font-mono">settings.json</code>,{" "}
          <code className="font-mono">models.json</code>,{" "}
          <code className="font-mono">skills-overrides.json</code>, and{" "}
          <code className="font-mono">tool-overrides.json</code>. Provider auth (
          <code className="font-mono">auth.json</code> — API keys, OAuth tokens) is{" "}
          <strong>not</strong> included; re-authenticate providers after restoring on a new install.
        </p>
        <button
          onClick={() => void onExport()}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 hover:border-neutral-500 disabled:opacity-50"
        >
          {busy ? "Exporting…" : "Download config archive"}
        </button>
        {lastExport !== undefined && (
          <p className="mt-2 text-xs text-emerald-400 light:text-emerald-700">
            Exported <code className="font-mono">{lastExport.filename}</code> (
            {lastExport.files.length === 0
              ? "no files were on disk"
              : `included: ${lastExport.files.join(", ")}`}
            )
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-100">Import config</h3>
        <p className="mb-3 text-xs text-neutral-400">
          Restores a previously-exported archive. Each file is parsed before any disk write — if any
          file fails validation, <strong>nothing</strong> is imported. Existing live agent sessions
          keep their original settings until restarted.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".gz,.tgz,application/gzip,application/x-gzip"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void onImport(file);
          }}
          className="block text-xs text-neutral-300 file:mr-3 file:rounded file:border file:border-neutral-700 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:text-neutral-100 hover:file:border-neutral-500 disabled:opacity-50"
        />
        {lastImport !== undefined && (
          <div className="mt-3 space-y-1 text-xs">
            {lastImport.imported.length > 0 && (
              <p className="text-emerald-400 light:text-emerald-700">
                Imported: <code className="font-mono">{lastImport.imported.join(", ")}</code>
              </p>
            )}
            {lastImport.skipped.length > 0 && (
              <p className="text-amber-400 light:text-amber-700">
                Skipped (not in allow-list):{" "}
                <code className="font-mono">{lastImport.skipped.join(", ")}</code>
              </p>
            )}
            {lastImport.errors.length > 0 && (
              <div className="text-red-400">
                <p>Errors — nothing was written:</p>
                <ul className="ml-4 list-disc">
                  {lastImport.errors.map((e) => (
                    <li key={e.file}>
                      <code className="font-mono">{e.file}</code>: {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {lastImport.imported.length === 0 &&
              lastImport.errors.length === 0 &&
              lastImport.skipped.length === 0 && (
                <p className="italic text-neutral-500">Archive was empty.</p>
              )}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-100">Export skills</h3>
        <p className="mb-3 text-xs text-neutral-400">
          Downloads a <code className="font-mono">.tar.gz</code> of every file under{" "}
          <code className="font-mono">~/.pi/agent/skills/</code> — both single-file (
          <code className="font-mono">{`<name>.md`}</code>) and directory skills (
          <code className="font-mono">{`<name>/SKILL.md`}</code> + assets) round-trip verbatim.
        </p>
        <button
          onClick={() => void onExportSkills()}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 hover:border-neutral-500 disabled:opacity-50"
        >
          {busy ? "Working…" : "Download skills archive"}
        </button>
        {lastSkillsExport !== undefined &&
          (lastSkillsExport.fileCount === 0 ? (
            // Empty-skills sentinel: server returned 409
            // skills_directory_empty. Show as a neutral info line, not
            // an error — there's nothing wrong, just nothing to ship.
            <p className="mt-2 text-xs text-neutral-400">
              No skills to export — your skills directory is empty.
            </p>
          ) : (
            <p className="mt-2 text-xs text-emerald-400 light:text-emerald-700">
              Exported <code className="font-mono">{lastSkillsExport.filename}</code> (
              {lastSkillsExport.fileCount} file{lastSkillsExport.fileCount === 1 ? "" : "s"} packed)
            </p>
          ))}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-100">Import skills</h3>
        <p className="mb-3 text-xs text-neutral-400">
          Restore skills from a previously-exported <code className="font-mono">.tar.gz</code>, OR
          upload a folder of skill files directly. Existing files at the same path are{" "}
          <strong>overwritten</strong>; new files are added. Path traversal and absolute paths are
          rejected.
        </p>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              From tar.gz
            </span>
            <input
              ref={skillsTarInputRef}
              type="file"
              accept=".gz,.tgz,application/gzip,application/x-gzip"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) void onImportSkills([file]);
              }}
              className="block text-xs text-neutral-300 file:mr-3 file:rounded file:border file:border-neutral-700 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:text-neutral-100 hover:file:border-neutral-500 disabled:opacity-50"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              From folder (Chromium / WebKit only)
            </span>
            <input
              ref={skillsFolderInputRef}
              type="file"
              multiple
              // `webkitdirectory` lets the user pick a directory; the
              // browser sends each contained file as a separate
              // multipart entry with the relative path in
              // `webkitRelativePath`. Firefox doesn't implement this
              // attribute — fall back to the tar.gz path above.
              {...({ webkitdirectory: "" } as Record<string, string>)}
              disabled={busy}
              onChange={(e) => {
                const files = e.target.files;
                if (files === null || files.length === 0) return;
                void onImportSkills(Array.from(files));
              }}
              className="block text-xs text-neutral-300 file:mr-3 file:rounded file:border file:border-neutral-700 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:text-neutral-100 hover:file:border-neutral-500 disabled:opacity-50"
            />
          </label>
        </div>
        {lastSkillsImport !== undefined && (
          <div className="mt-3 space-y-1 text-xs">
            {lastSkillsImport.imported.length > 0 && (
              <p className="text-emerald-400 light:text-emerald-700">
                Imported {lastSkillsImport.imported.length} file
                {lastSkillsImport.imported.length === 1 ? "" : "s"}:{" "}
                <code className="font-mono">{lastSkillsImport.imported.join(", ")}</code>
              </p>
            )}
            {lastSkillsImport.skipped.length > 0 && (
              <div className="text-amber-400 light:text-amber-700">
                <p>
                  Skipped {lastSkillsImport.skipped.length} entr
                  {lastSkillsImport.skipped.length === 1 ? "y" : "ies"}:
                </p>
                <ul className="ml-4 list-disc">
                  {lastSkillsImport.skipped.map((s) => (
                    <li key={s.name}>
                      <code className="font-mono">{s.name}</code> ({s.reason})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {lastSkillsImport.imported.length === 0 && lastSkillsImport.skipped.length === 0 && (
              <p className="italic text-neutral-500">No files were imported.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------- MCP tab ----------------

interface McpDraft {
  name: string;
  /** Discriminator. The form picks the field set based on this. */
  kind: "remote" | "stdio";
  enabled: boolean;
  // Remote fields
  url: string;
  transport: McpTransport;
  /** Headers as a flat ordered list so the user can manage rows. */
  headers: { key: string; value: string }[];
  // Stdio fields
  command: string;
  /** Args as a single textarea-friendly string; one arg per line.
   *  Parsed at save time. Stored as a string (not string[]) so the
   *  user can type freely without each newline reshuffling the
   *  controlled component. */
  argsText: string;
  /** Env as a flat ordered list; same shape + redaction handling as
   *  headers, so the form reuses the same row UI. */
  env: { key: string; value: string }[];
  /** Optional cwd; blank ↦ default (project path for project
   *  servers, pi-forge process cwd for global). */
  cwd: string;
}

const SECRET_PLACEHOLDER = "***REDACTED***";

function emptyDraft(): McpDraft {
  return {
    name: "",
    kind: "remote",
    enabled: true,
    url: "",
    transport: "auto",
    headers: [],
    command: "",
    argsText: "",
    env: [],
    cwd: "",
  };
}

/** Split the textarea-style args field into the array shape the
 *  server expects. Blank lines are dropped so a trailing newline
 *  doesn't produce a ghost empty arg. */
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function McpTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const project = useActiveProject();
  const projects = useProjectStore((s) => s.projects);
  // All polled state lives in mcp-store now (single 30s ticker shared
  // with the header badge). The tab does its own one-shot per-project
  // refresh on mount + project switch so the row list reflects the
  // selected project's .mcp.json without waiting for the next tick.
  const settings = useMcpStore((s) => s.settings);
  const servers = useMcpStore((s) => s.globalServers);
  // Stable EMPTY_STATUS fallback — see store doc-comment. Returning
  // a fresh `[]` literal from this selector re-renders on every store
  // update and crashes the tree with "Maximum update depth exceeded."
  const status = useMcpStore(
    (s) => s.byProject[project?.id ?? "__no_project__"]?.status ?? EMPTY_STATUS,
  );
  const stdioTrust = useMcpStore((s) => s.byProject[project?.id ?? "__no_project__"]?.stdioTrust);
  const refreshProject = useMcpStore((s) => s.refreshProject);
  const setMcpEnabled = useMcpStore((s) => s.setMcpEnabled);
  const setMcpTruncation = useMcpStore((s) => s.setMcpTruncation);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const probeServerStore = useMcpStore((s) => s.probeServer);
  const grantStdioTrust = useMcpStore((s) => s.grantStdioTrust);
  const revokeStdioTrust = useMcpStore((s) => s.revokeStdioTrust);

  const [draft, setDraft] = useState<McpDraft | undefined>(undefined);
  /** When set, draft applies to an existing server (PUT replaces). */
  const [editingName, setEditingName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState<string | undefined>(undefined);
  const [truncationMaxDraft, setTruncationMaxDraft] = useState<string | undefined>(undefined);

  // Per-tool listing fetched alongside the server config so each
  // server row can cascade its tools (each tool gets its own
  // ToolCascadeRow with the same per-project override pattern as
  // the Tools tab). Keyed by `<scope>:<server>` to dodge global-vs-
  // project name collisions. Cascade overrides come in via the
  // separate `allOverrides` fetch so a project switch doesn't have
  // to re-query the listing.
  const [toolsByServer, setToolsByServer] = useState<Map<string, McpToolRow[]>>(new Map());
  const [allOverrides, setAllOverrides] = useState<
    Record<
      string,
      {
        builtin: { enable: string[]; disable: string[] };
        mcp: { enable: string[]; disable: string[] };
        extension: { enable: string[]; disable: string[] };
      }
    >
  >({});
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  const refreshTools = async (): Promise<void> => {
    try {
      const [listing, overrides] = await Promise.all([
        api.listTools(project?.id),
        api.listToolOverrides(),
      ]);
      const next = new Map<string, McpToolRow[]>();
      for (const srv of listing.mcp) {
        next.set(`${srv.scope}:${srv.server}`, srv.tools);
      }
      setToolsByServer(next);
      setAllOverrides(overrides.projects);
    } catch (err) {
      // Tools listing is best-effort — failure shouldn't block the
      // server config UI from rendering. Surface but don't block.
      onError(`Failed to load tool listing: ${errorCode(err)}`);
    }
  };

  useEffect(() => {
    void refreshProject(project?.id).catch((err: unknown) => {
      onError(`Failed to load MCP config: ${errorCode(err)}`);
    });
    void refreshTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const toggleMaster = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      await setMcpEnabled(next);
      onError(undefined);
      // refreshProject pulls in updated status counts.
      await refreshProject(project?.id);
    } catch (err) {
      onError(`Failed to toggle MCP: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveTruncation = async (next: { enabled: boolean; maxChars: number }): Promise<void> => {
    setBusy(true);
    try {
      await setMcpTruncation(next);
      setTruncationMaxDraft(undefined);
      onError(undefined);
    } catch (err) {
      onError(`Failed to update MCP truncation: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = async (name: string, next: boolean): Promise<void> => {
    const prev = servers[name];
    if (prev === undefined) return;
    setBusy(true);
    try {
      await upsertServer(name, { ...prev, enabled: next });
      onError(undefined);
    } catch (err) {
      onError(`Failed to update server: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (name: string): void => {
    const cfg = servers[name];
    if (cfg === undefined) return;
    setEditingName(name);
    const isStdio = typeof cfg.command === "string" && cfg.command.length > 0;
    setDraft({
      name,
      kind: isStdio ? "stdio" : "remote",
      enabled: cfg.enabled !== false,
      url: cfg.url ?? "",
      transport: cfg.transport ?? "auto",
      headers: Object.entries(cfg.headers ?? {}).map(([k, v]) => ({ key: k, value: v })),
      command: cfg.command ?? "",
      argsText: (cfg.args ?? []).join("\n"),
      env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ key: k, value: v })),
      cwd: cfg.cwd ?? "",
    });
  };

  const startAdd = (): void => {
    setEditingName(undefined);
    setDraft(emptyDraft());
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === undefined) return;
    if (draft.name.trim().length === 0) {
      onError("Name is required.");
      return;
    }
    if (draft.kind === "remote" && draft.url.trim().length === 0) {
      onError("URL is required for remote servers.");
      return;
    }
    if (draft.kind === "stdio" && draft.command.trim().length === 0) {
      onError("Command is required for stdio servers.");
      return;
    }
    const body: McpServerConfig = { enabled: draft.enabled };
    if (draft.kind === "remote") {
      body.url = draft.url;
      body.transport = draft.transport;
      const headers: Record<string, string> = {};
      for (const h of draft.headers) {
        if (h.key.trim().length === 0) continue;
        headers[h.key] = h.value;
      }
      if (Object.keys(headers).length > 0) body.headers = headers;
    } else {
      body.command = draft.command;
      const args = parseArgs(draft.argsText);
      if (args.length > 0) body.args = args;
      const env: Record<string, string> = {};
      for (const e of draft.env) {
        if (e.key.trim().length === 0) continue;
        env[e.key] = e.value;
      }
      if (Object.keys(env).length > 0) body.env = env;
      if (draft.cwd.trim().length > 0) body.cwd = draft.cwd;
    }
    setBusy(true);
    try {
      await upsertServer(draft.name, body);
      onError(undefined);
      setDraft(undefined);
      setEditingName(undefined);
    } catch (err) {
      onError(`Failed to save server: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (name: string): Promise<void> => {
    if (!window.confirm(`Remove MCP server '${name}' from the global registry?`)) return;
    setBusy(true);
    try {
      await deleteServer(name);
      onError(undefined);
    } catch (err) {
      onError(`Failed to remove server: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const probeServer = async (name: string, scope: "global" | "project"): Promise<void> => {
    setProbing(name);
    try {
      await probeServerStore(name, scope === "project" ? project?.id : undefined);
      onError(undefined);
      // After a probe the tool list may have changed (newly-connected
      // server populates its tools). Refresh in the background.
      void refreshTools();
    } catch (err) {
      onError(`Probe failed for '${name}': ${errorCode(err)}`);
    } finally {
      setProbing(undefined);
    }
  };

  const toggleToolGlobal = async (fqn: string, nextEnabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.setToolEnabled("mcp", fqn, nextEnabled, "global");
      await refreshTools();
    } catch (err) {
      onError(`Toggle failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setProjectToolOverride = async (
    targetProjectId: string,
    fqn: string,
    state: "enabled" | "disabled" | undefined,
  ): Promise<void> => {
    setBusy(true);
    try {
      if (state === undefined) {
        await api.clearToolProjectOverride("mcp", fqn, targetProjectId);
      } else {
        await api.setToolEnabled("mcp", fqn, state === "enabled", "project", targetProjectId);
      }
      await refreshTools();
    } catch (err) {
      onError(`Override write failed: ${errorCode(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleServerExpanded = (serverKey: string): void => {
    setExpandedServers((cur) => {
      const next = new Set(cur);
      if (next.has(serverKey)) next.delete(serverKey);
      else next.add(serverKey);
      return next;
    });
  };

  if (settings === undefined) {
    return <p className="text-xs italic text-neutral-500">Loading MCP config…</p>;
  }

  const enabled = settings.enabled;
  const globalStatus = status.filter((s) => s.scope === "global");
  const projectStatus = status.filter((s) => s.scope === "project");

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        MCP servers extend the agent with custom tools. Servers configured here are loaded by every
        new session. Project-scoped servers in <code className="font-mono">.mcp.json</code> at the
        project root are also loaded for sessions in that project (project entries override globals
        on name collision).
      </p>

      <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-neutral-100">MCP tools</div>
            <div className="text-[11px] text-neutral-500">
              Master switch. When off, no MCP tools reach the agent regardless of per-server state.
            </div>
          </div>
          <button
            onClick={() => void toggleMaster(!enabled)}
            disabled={busy}
            className={`rounded border px-3 py-1 text-xs ${
              enabled
                ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
            }`}
          >
            {enabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-neutral-800 pt-3">
          <div className="min-w-[240px] flex-1">
            <div className="text-sm font-medium text-neutral-100">Result truncation</div>
            <div className="text-[11px] text-neutral-500">
              Caps total text returned by each MCP tool before it enters agent context. Images pass
              through unchanged. Disable only for trusted, bounded tools.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-neutral-500" htmlFor="mcp-truncation-max">
              Max chars
            </label>
            <input
              id="mcp-truncation-max"
              type="number"
              min={1}
              max={1000000}
              value={truncationMaxDraft ?? String(settings.truncation.maxChars)}
              onChange={(e) => setTruncationMaxDraft(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(
                  truncationMaxDraft ?? String(settings.truncation.maxChars),
                  10,
                );
                if (
                  Number.isFinite(parsed) &&
                  parsed >= 1 &&
                  parsed !== settings.truncation.maxChars
                ) {
                  void saveTruncation({ ...settings.truncation, maxChars: parsed });
                } else {
                  setTruncationMaxDraft(undefined);
                }
              }}
              disabled={busy || !settings.truncation.enabled}
              className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 disabled:opacity-50"
            />
            <button
              onClick={() =>
                void saveTruncation({
                  ...settings.truncation,
                  enabled: !settings.truncation.enabled,
                })
              }
              disabled={busy}
              className={`rounded border px-3 py-1 text-xs ${
                settings.truncation.enabled
                  ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              {settings.truncation.enabled ? "Truncating" : "Pass-through"}
            </button>
          </div>
        </div>
      </div>

      {project !== undefined && (
        <StdioTrustBanner
          projectName={project.name}
          trusted={stdioTrust?.trusted === true}
          gatedCount={
            status.filter((s) => s.scope === "project" && s.state === "trust_required").length
          }
          busy={busy}
          onGrant={async () => {
            setBusy(true);
            try {
              await grantStdioTrust(project.id);
              onError(undefined);
            } catch (err) {
              onError(`Failed to grant trust: ${errorCode(err)}`);
            } finally {
              setBusy(false);
            }
          }}
          onRevoke={async () => {
            if (
              !window.confirm(
                `Revoke stdio MCP trust for "${project.name}"? This disconnects every running project-scoped MCP server.`,
              )
            ) {
              return;
            }
            setBusy(true);
            try {
              await revokeStdioTrust(project.id);
              onError(undefined);
            } catch (err) {
              onError(`Failed to revoke trust: ${errorCode(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      <McpServerList
        title="Global servers"
        emptyHint="No global MCP servers configured. Click 'Add server' to add one."
        servers={globalStatus.map((s) => ({ status: s, config: servers[s.name] }))}
        editable
        editingName={editingName ?? null}
        probingName={probing ?? null}
        toolsByServer={toolsByServer}
        expandedServers={expandedServers}
        allOverrides={allOverrides}
        projects={projects}
        busy={busy}
        onToggleExpanded={toggleServerExpanded}
        onToggleToolGlobal={(fqn, next) => void toggleToolGlobal(fqn, next)}
        onSetProjectToolOverride={(projectId, fqn, next) =>
          void setProjectToolOverride(projectId, fqn, next)
        }
        onToggle={(name, next) => void toggleServer(name, next)}
        onProbe={(name) => void probeServer(name, "global")}
        onEdit={startEdit}
        onRemove={(name) => void removeServer(name)}
      />

      {project !== undefined && (
        <McpServerList
          title={`Project servers (${project.name})`}
          emptyHint={
            <>
              No project servers. Add a <code className="font-mono">.mcp.json</code> file at the
              project root to define some — supports both{" "}
              <code className="font-mono">{`{ servers: {...} }`}</code> and the standard{" "}
              <code className="font-mono">{`{ mcpServers: {...} }`}</code> shape.
            </>
          }
          servers={projectStatus.map((s) => ({ status: s, config: undefined }))}
          editable={false}
          probingName={probing ?? null}
          toolsByServer={toolsByServer}
          expandedServers={expandedServers}
          allOverrides={allOverrides}
          projects={projects}
          busy={busy}
          onToggleExpanded={toggleServerExpanded}
          onToggleToolGlobal={(fqn, next) => void toggleToolGlobal(fqn, next)}
          onSetProjectToolOverride={(projectId, fqn, next) =>
            void setProjectToolOverride(projectId, fqn, next)
          }
          onProbe={(name) => void probeServer(name, "project")}
        />
      )}

      {draft === undefined ? (
        <button
          onClick={startAdd}
          className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500"
        >
          + Add server
        </button>
      ) : (
        <McpDraftForm
          draft={draft}
          isEditing={editingName !== undefined}
          busy={busy}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onCancel={() => {
            setDraft(undefined);
            setEditingName(undefined);
          }}
        />
      )}
    </div>
  );
}

interface ServerRowEntry {
  status: McpServerStatus;
  config: McpServerConfig | undefined;
}

interface McpToolRow {
  name: string;
  shortName: string;
  description: string;
  /** Effective state for the active project (or global when no project active). */
  enabled: boolean;
  /** Underlying global state regardless of project override — used to label
   *  the global toggle button when a project tri-state is in play. */
  globalEnabled: boolean;
  /** Active project's tri-state position, absent = inherit. */
  projectOverride?: "enabled" | "disabled";
}

function McpServerList(props: {
  title: string;
  emptyHint: React.ReactNode;
  servers: ServerRowEntry[];
  editable: boolean;
  /** `null` (not undefined) when no row is being edited — sidesteps
   *  `exactOptionalPropertyTypes` complaining about `string | undefined`
   *  being assigned to an optional prop typed as `string`. */
  editingName?: string | null;
  probingName?: string | null;
  /** Per-server tool listing keyed by `<scope>:<server>` so the cascade
   *  can disambiguate global vs project servers with the same name. */
  toolsByServer: Map<string, McpToolRow[]>;
  /** Same `<scope>:<server>` keys for the expand state. */
  expandedServers: Set<string>;
  /** Cascade payload: every project's per-tool override map. Used by
   *  the inline ToolCascadeRow under each server's expanded panel. */
  allOverrides: Record<
    string,
    {
      builtin: { enable: string[]; disable: string[] };
      mcp: { enable: string[]; disable: string[] };
      extension: { enable: string[]; disable: string[] };
    }
  >;
  projects: { id: string; name: string; path: string }[];
  busy: boolean;
  onToggleExpanded: (serverKey: string) => void;
  /** Toggle a tool's GLOBAL default. */
  onToggleToolGlobal: (fqn: string, nextEnabled: boolean) => void;
  /** Set or clear a per-project tri-state override for a tool. */
  onSetProjectToolOverride: (
    projectId: string,
    fqn: string,
    next: "enabled" | "disabled" | undefined,
  ) => void;
  onToggle?: (name: string, enabled: boolean) => void;
  onProbe: (name: string) => void;
  onEdit?: (name: string) => void;
  onRemove?: (name: string) => void;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
        {props.title}
      </h3>
      {props.servers.length === 0 ? (
        <p className="text-[11px] italic text-neutral-500">{props.emptyHint}</p>
      ) : (
        <div className="space-y-2">
          {props.servers.map((entry) => {
            const s = entry.status;
            const isEditing = props.editingName === s.name;
            const isProbing = props.probingName === s.name;
            const serverKey = `${s.scope}:${s.name}`;
            const tools = props.toolsByServer.get(serverKey) ?? [];
            const expanded = props.expandedServers.has(serverKey);
            const canExpand = tools.length > 0;
            return (
              <div
                key={serverKey}
                className={`rounded border ${
                  isEditing
                    ? "border-neutral-500 bg-neutral-900"
                    : "border-neutral-800 bg-neutral-900/40"
                }`}
              >
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Cascade caret. Lucide icon (vs unicode arrow)
                          for visual contrast — the arrows were too
                          dim against the neutral background to read
                          as a clickable affordance. */}
                      <button
                        type="button"
                        onClick={() => canExpand && props.onToggleExpanded(serverKey)}
                        disabled={!canExpand}
                        className="flex h-5 w-5 items-center justify-center rounded text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-30"
                        title={
                          canExpand
                            ? expanded
                              ? "Hide tools"
                              : "Show tools"
                            : "No tools to show (server not connected or empty)"
                        }
                      >
                        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                      <McpStateDot state={s.state} />
                      <span className="font-mono text-sm text-neutral-100">{s.name}</span>
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                        {s.transport ?? "auto"}
                      </span>
                      <span className="text-[11px] text-neutral-500">{s.toolCount} tools</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                      {props.editable && props.onToggle !== undefined && (
                        <button
                          onClick={() => props.onToggle?.(s.name, !s.enabled)}
                          className={`rounded border px-2 py-0.5 ${
                            s.enabled
                              ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800"
                              : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                          }`}
                        >
                          {s.enabled ? "Enabled" : "Disabled"}
                        </button>
                      )}
                      <button
                        onClick={() => props.onProbe(s.name)}
                        disabled={isProbing}
                        className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
                        title="Reconnect and refresh tool list"
                      >
                        {isProbing ? "Probing…" : "Probe"}
                      </button>
                      {props.editable && props.onEdit !== undefined && (
                        <button
                          onClick={() => props.onEdit?.(s.name)}
                          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
                        >
                          Edit
                        </button>
                      )}
                      {props.editable && props.onRemove !== undefined && (
                        <button
                          onClick={() => props.onRemove?.(s.name)}
                          className="rounded border border-red-700/50 px-2 py-0.5 text-red-300 hover:bg-red-900/20"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                  {s.kind === "stdio" ? (
                    <div
                      className="mt-1 truncate font-mono text-[11px] text-neutral-500"
                      title={`${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim()}
                    >
                      {s.command} {(s.args ?? []).join(" ")}
                    </div>
                  ) : (
                    <div className="mt-1 truncate text-[11px] text-neutral-500" title={s.url ?? ""}>
                      {s.url}
                    </div>
                  )}
                  {s.lastError !== undefined && (
                    <div
                      className="mt-1 truncate text-[11px] text-red-300 light:text-red-700"
                      title={s.lastError}
                    >
                      {s.lastError}
                    </div>
                  )}
                </div>
                {expanded && canExpand && (
                  <div className="space-y-2 border-t border-neutral-800 bg-neutral-950/40 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                      Tools
                    </div>
                    <div className="space-y-2">
                      {tools.map((t) => (
                        <ToolCascadeRow
                          key={`mcp:${t.name}`}
                          family="mcp"
                          name={t.shortName}
                          fqn={t.name}
                          description={t.description}
                          globalEnabled={t.globalEnabled}
                          projects={props.projects}
                          allOverrides={props.allOverrides}
                          busy={props.busy}
                          onToggleGlobal={(next) => props.onToggleToolGlobal(t.name, next)}
                          onSetProjectOverride={(projectId, state) =>
                            props.onSetProjectToolOverride(projectId, t.name, state)
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function McpStateDot({ state }: { state: McpServerStatus["state"] }) {
  const cls =
    state === "connected"
      ? "bg-emerald-500"
      : state === "connecting"
        ? "bg-amber-400 animate-pulse"
        : state === "error"
          ? "bg-red-500"
          : state === "disabled"
            ? "bg-neutral-700"
            : "bg-neutral-500";
  return <span className={`h-2 w-2 rounded-full ${cls}`} title={state} />;
}

/**
 * Per-project stdio MCP trust prompt + status. Renders three states:
 *
 *  1. Untrusted + no gated entries → small dim "stdio MCP trust:
 *     not granted" note. No CTA — there's nothing to spawn anyway.
 *  2. Untrusted + ≥1 gated entry → prominent amber banner with
 *     "Trust this project" CTA. This is the path most users will
 *     hit after `git clone`'ing a project with a project-local
 *     `.mcp.json` that declares stdio entries.
 *  3. Trusted → small dim "trusted" note with a Revoke link.
 *     Surfaces the decision so the user can undo it without
 *     hunting through Settings.
 */
function StdioTrustBanner(props: {
  projectName: string;
  trusted: boolean;
  gatedCount: number;
  busy: boolean;
  onGrant: () => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
}) {
  if (props.trusted) {
    return (
      <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11px] text-neutral-500">
        <span>
          Stdio MCP trust granted for{" "}
          <strong className="text-neutral-300">{props.projectName}</strong>. Project-local stdio MCP
          servers from <code className="font-mono">.mcp.json</code> will spawn on session create.
        </span>
        <button
          onClick={() => void props.onRevoke()}
          disabled={props.busy}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-50"
          title="Disconnects every running project-scoped MCP server"
        >
          Revoke
        </button>
      </div>
    );
  }
  if (props.gatedCount === 0) {
    return null;
  }
  return (
    <div className="rounded border border-amber-700/40 bg-amber-900/20 p-3 text-xs text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
      <div className="mb-2 font-medium">
        This project wants to spawn {props.gatedCount} stdio MCP server
        {props.gatedCount === 1 ? "" : "s"}.
      </div>
      <p className="text-[11px] leading-relaxed">
        <strong>{props.projectName}</strong>'s <code className="font-mono">.mcp.json</code> declares
        MCP server{props.gatedCount === 1 ? "" : "s"} that pi-forge would launch as local subprocess
        {props.gatedCount === 1 ? "" : "es"}. Stdio MCP runs arbitrary commands on this machine with
        whatever env you've passed through — only trust projects whose{" "}
        <code className="font-mono">.mcp.json</code> you've reviewed and approve of. Remote (URL)
        entries in this project are unaffected by this gate.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void props.onGrant()}
          disabled={props.busy}
          className="rounded bg-amber-200 px-3 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 light:bg-amber-600 light:text-amber-50 light:hover:bg-amber-700"
        >
          {props.busy ? "Granting…" : "Trust this project"}
        </button>
      </div>
    </div>
  );
}

function McpDraftForm(props: {
  draft: McpDraft;
  isEditing: boolean;
  busy: boolean;
  onChange: (next: McpDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { draft, busy } = props;
  const setField = <K extends keyof McpDraft>(key: K, value: McpDraft[K]): void => {
    props.onChange({ ...draft, [key]: value });
  };
  return (
    <div className="rounded border border-neutral-700 bg-neutral-900 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        {props.isEditing ? `Edit '${draft.name}'` : "Add MCP server"}
      </h4>

      {/* Kind selector — locked on edit to prevent silently moving a
          remote server to stdio (which would drop its URL/headers on
          save and re-spawn nothing useful). Delete + re-add to swap. */}
      <div className="mb-3 flex items-center gap-3 rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px]">
        <span className="text-neutral-500">Type</span>
        <label
          className={`flex items-center gap-1.5 ${props.isEditing ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
          <input
            type="radio"
            name="mcp-kind"
            checked={draft.kind === "remote"}
            disabled={props.isEditing}
            onChange={() => setField("kind", "remote")}
          />
          <span>Remote URL</span>
        </label>
        <label
          className={`flex items-center gap-1.5 ${props.isEditing ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
          <input
            type="radio"
            name="mcp-kind"
            checked={draft.kind === "stdio"}
            disabled={props.isEditing}
            onChange={() => setField("kind", "stdio")}
          />
          <span>Local subprocess (stdio)</span>
        </label>
        {props.isEditing && (
          <span className="text-[10px] italic text-neutral-600">
            Locked while editing — delete and re-add to change type.
          </span>
        )}
      </div>

      <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <label className="text-neutral-500">Name</label>
        <input
          value={draft.name}
          onChange={(e) => setField("name", e.target.value)}
          disabled={props.isEditing}
          placeholder="my-server"
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-50"
        />

        {draft.kind === "remote" ? (
          <>
            <label className="text-neutral-500">URL</label>
            <input
              value={draft.url}
              onChange={(e) => setField("url", e.target.value)}
              placeholder="https://mcp.example.com/sse"
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500"
            />
            <label className="text-neutral-500">Transport</label>
            <select
              value={draft.transport}
              onChange={(e) => setField("transport", e.target.value as McpTransport)}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500"
            >
              <option value="auto">auto (StreamableHTTP, fall back to SSE)</option>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </select>
          </>
        ) : (
          <>
            <label className="text-neutral-500">Command</label>
            <input
              value={draft.command}
              onChange={(e) => setField("command", e.target.value)}
              placeholder="npx (or absolute path to a binary)"
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-neutral-100 outline-none focus:border-neutral-500"
            />
            <label className="self-start pt-1 text-neutral-500">Args</label>
            <textarea
              value={draft.argsText}
              onChange={(e) => setField("argsText", e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-everything"}
              rows={3}
              spellCheck={false}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
            />
            <label className="text-neutral-500">cwd</label>
            <input
              value={draft.cwd}
              onChange={(e) => setField("cwd", e.target.value)}
              placeholder="(blank ↦ default: project path for project servers)"
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-neutral-100 outline-none focus:border-neutral-500"
            />
          </>
        )}

        <label className="text-neutral-500">Enabled</label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setField("enabled", e.target.checked)}
          />
          <span className="text-[11px] text-neutral-500">
            Disabled servers don't connect or contribute tools.
          </span>
        </label>
      </div>

      {draft.kind === "remote" ? (
        <SecretRowsEditor
          label="Headers"
          emptyHint="No headers. Add `Authorization: Bearer …` here for auth."
          keyPlaceholder="Authorization"
          valuePlaceholder="Bearer …"
          rows={draft.headers}
          onChange={(next) => setField("headers", next)}
        />
      ) : (
        <SecretRowsEditor
          label="Env"
          emptyHint="No env. Add API keys / config your subprocess needs (PATH / HOME / locale are inherited automatically)."
          keyPlaceholder="GITHUB_TOKEN"
          valuePlaceholder="ghp_…"
          rows={draft.env}
          onChange={(next) => setField("env", next)}
        />
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={props.onCancel}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500"
        >
          Cancel
        </button>
        <button
          onClick={props.onSave}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Shared key/value editor used by both the Headers (remote) and Env
 * (stdio) sections. Same visual + the same redaction-sentinel
 * round-trip pattern — the value field renders blank when the
 * stored value is the sentinel so the user types a replacement
 * instead of "editing" the placeholder.
 */
function SecretRowsEditor(props: {
  label: string;
  emptyHint: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: { key: string; value: string }[];
  onChange: (next: { key: string; value: string }[]) => void;
}) {
  const { rows } = props;
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <h5 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {props.label}
        </h5>
        <button
          onClick={() => props.onChange([...rows, { key: "", value: "" }])}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          + {props.label.replace(/s$/, "")}
        </button>
      </div>
      {rows.length === 0 && (
        <p className="text-[11px] italic text-neutral-600">{props.emptyHint}</p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="mb-1 grid grid-cols-[1fr_2fr_auto] gap-1">
          <input
            value={r.key}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...r, key: e.target.value };
              props.onChange(next);
            }}
            placeholder={props.keyPlaceholder}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] font-mono text-neutral-100 outline-none focus:border-neutral-500"
          />
          <input
            value={r.value === SECRET_PLACEHOLDER ? "" : r.value}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...r, value: e.target.value };
              props.onChange(next);
            }}
            placeholder={
              r.value === SECRET_PLACEHOLDER
                ? "leave blank to keep stored value"
                : props.valuePlaceholder
            }
            type="password"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] font-mono text-neutral-100 outline-none focus:border-neutral-500"
          />
          <button
            onClick={() => props.onChange(rows.filter((_, j) => j !== i))}
            className="rounded border border-neutral-700 px-2 text-[11px] text-neutral-400 hover:text-red-300 light:hover:text-red-700"
            title={`Remove ${props.label.toLowerCase()}`}
          >
            ×
          </button>
        </div>
      ))}
      {rows.some((r) => r.value === SECRET_PLACEHOLDER) && (
        <p className="mt-1 text-[10px] italic text-neutral-500">
          Values with the redaction sentinel keep their stored value when you save.
        </p>
      )}
    </div>
  );
}

// ---------------- General tab ----------------

const MIN_PASSWORD_LENGTH = 8;

/**
 * Catch-all "what am I running + account" pane. Combines the previous
 * About pane (version + links) with an in-place password-change form
 * for deployments that use UI_PASSWORD auth. The password section
 * hides on API-key-only deployments — there's nothing to change in
 * that case.
 */
function GeneralTab() {
  const version = useUiConfigStore((s) => s.version);
  const loaded = useUiConfigStore((s) => s.loaded);
  const passwordAuthEnabled = useUiConfigStore((s) => s.passwordAuthEnabled);
  return (
    <div className="space-y-6 text-sm text-neutral-300">
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-neutral-100">pi-forge</h2>
        <p className="text-xs text-neutral-500">
          Browser interface for the{" "}
          <a
            href="https://github.com/badlogic/pi-mono"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline hover:text-blue-300 light:text-blue-700 light:hover:text-blue-900"
          >
            pi coding agent
          </a>
          .
        </p>
      </header>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Version</h3>
        <p className="font-mono text-sm">
          {loaded ? (
            version.length > 0 ? (
              version
            ) : (
              <span className="text-neutral-500">unknown</span>
            )
          ) : (
            <span className="text-neutral-500">loading…</span>
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Links</h3>
        <ul className="space-y-1 text-xs">
          <li>
            <a
              href="https://github.com/Devin-Marks/pi-forge"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300 light:text-blue-700 light:hover:text-blue-900"
            >
              github.com/Devin-Marks/pi-forge
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Devin-Marks/pi-forge/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300 light:text-blue-700 light:hover:text-blue-900"
            >
              Changelog
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Devin-Marks/pi-forge/blob/main/SECURITY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300 light:text-blue-700 light:hover:text-blue-900"
            >
              Security
            </a>
          </li>
        </ul>
      </section>

      {passwordAuthEnabled && <ChangePasswordSection />}
    </div>
  );
}

/**
 * Inline password-change form mirroring the UX of the forced
 * first-login ChangePasswordScreen but rendered inside Settings →
 * General. Reuses the existing useAuthStore.changePassword action
 * (which handles hashing on the server, atomic write to
 * password-hash, and re-issuing the JWT). Reads pending + error
 * state from the same store so a failed change persists across
 * re-renders.
 */
function ChangePasswordSection() {
  const changePassword = useAuthStore((s) => s.changePassword);
  const pending = useAuthStore((s) => s.changePasswordPending);
  const remoteError = useAuthStore((s) => s.changePasswordError);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  // Prior pending state — rising-edge detect on `pending` flipping
  // false with no remoteError tells us a successful save just landed,
  // so we can clear the form fields and surface a confirmation.
  const [savedFlash, setSavedFlash] = useState(false);
  const wasPendingRef = useRef(false);
  useEffect(() => {
    if (wasPendingRef.current && !pending && remoteError === undefined) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setSavedFlash(true);
      const t = window.setTimeout(() => setSavedFlash(false), 2500);
      return () => window.clearTimeout(t);
    }
    wasPendingRef.current = pending;
    return undefined;
  }, [pending, remoteError]);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setLocalError(undefined);
    setSavedFlash(false);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setLocalError("New password and confirmation do not match.");
      return;
    }
    if (next === current) {
      setLocalError("New password must differ from the current one.");
      return;
    }
    void changePassword(current, next);
  };

  const error = localError ?? friendlyChangePasswordError(remoteError);

  return (
    <section className="space-y-2 border-t border-neutral-800 pt-5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        Change password
      </h3>
      <p className="text-xs text-neutral-500">
        Updates the scrypt hash on disk; existing browser sessions stay signed in.
      </p>
      <form onSubmit={onSubmit} className="space-y-2">
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Current password</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">New password</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        {error !== undefined && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        {savedFlash && (
          <p role="status" className="text-xs text-emerald-400 light:text-emerald-700">
            Password updated.
          </p>
        )}
        <button
          type="submit"
          disabled={pending || current.length === 0 || next.length === 0}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : "Update password"}
        </button>
      </form>
    </section>
  );
}

function friendlyChangePasswordError(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  switch (code) {
    case "invalid_password":
      return "Current password is incorrect.";
    case "password_unchanged":
      return "New password must differ from the current one.";
    case "ui_password_not_configured":
      return "Password auth is not configured on this server.";
    case "auth_required":
      return "Session expired — sign in again.";
    default:
      return `Could not change password: ${code}`;
  }
}
