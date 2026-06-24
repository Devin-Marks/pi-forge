import { create } from "zustand";
import {
  api,
  ApiError,
  type McpServerConfig,
  type McpServerStatus,
  type McpSettingsResponse,
} from "../lib/api-client";

const POLL_INTERVAL_MS = 30_000;

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sameSettings(a: McpSettingsResponse | undefined, b: McpSettingsResponse): boolean {
  return (
    a?.enabled === b.enabled &&
    a.connected === b.connected &&
    a.total === b.total &&
    a.truncation.enabled === b.truncation.enabled &&
    a.truncation.maxChars === b.truncation.maxChars
  );
}

function sameProjectData(a: ProjectScopeData | undefined, b: ProjectScopeData): boolean {
  return (
    a !== undefined &&
    stableJson(a.status) === stableJson(b.status) &&
    stableJson(a.stdioTrust) === stableJson(b.stdioTrust)
  );
}

/**
 * Module-level stable empty array. Zustand selectors compare return
 * values by reference; returning a fresh `[]` from a `useMcpStore(s
 * => ... ?? [])` selector triggers a re-render on every store update
 * (the new literal is a different reference even when the underlying
 * value didn't change), eventually crashing the React tree with
 * "Maximum update depth exceeded." Mirrors `EMPTY_SESSIONS` in
 * session-store.ts for the same reason.
 */
export const EMPTY_STATUS: McpServerStatus[] = [];

/**
 * Centralised MCP state for every consumer in the client.
 *
 * Why a store and not per-component state: as of v1 there are two
 * consumers (`McpStatusBadge` in the App header, `McpTab` in
 * Settings). Both poll the same `/mcp/settings` endpoint on their own
 * timers — the badge every 30s, the tab on every render of the tab.
 * That's harmless today, but the moment a third consumer appears
 * (e.g. an "MCP tools available" affordance in the chat input,
 * or a status-aware notification when a server flips to error
 * mid-session), each addition multiplies the same poll. Lifting both
 * polled values into a store collapses the cadence to one ticker.
 *
 * State boundaries:
 *  - `settings` mirrors `GET /mcp/settings` (master toggle +
 *    connected/total summary). Drives the header badge.
 *  - `byProject[projectId]` caches `GET /mcp/servers?projectId=…`
 *    per active project. The Settings MCP tab subscribes to the
 *    entry for the currently-active project.
 *  - `globalServers` is the redacted GLOBAL `mcp.json` snapshot —
 *    same data on every project so it lives outside the by-project map.
 *  - Mutations (`setEnabled`, `upsertServer`, `deleteServer`,
 *    `probeServer`, `setMcpEnabled`) hit the API and refresh the
 *    affected slice on success. Failures bubble through the
 *    returned error so callers can surface them inline.
 *
 * Lifecycle: `startPolling()` is idempotent — called once from
 * App.tsx after auth. The interval is cleared on `stopPolling()`
 * (logout / unmount). Polling skips when `document.hidden` is true
 * so a backgrounded tab doesn't keep the pi-forge warm. Each tick
 * refreshes the header summary plus any project status slices that
 * a consumer has already loaded; unchanged payloads keep their
 * existing references to avoid UI churn.
 */

interface ProjectScopeData {
  /** Combined GLOBAL config + project status entries from the
   *  /mcp/servers?projectId= response. */
  status: McpServerStatus[];
  /** Has the operator granted this project stdio-MCP trust?
   *  `undefined` ↦ not yet loaded for this project. */
  stdioTrust?: { trusted: boolean };
  loadedAt: number;
}

interface McpState {
  settings: McpSettingsResponse | undefined;
  globalServers: Record<string, McpServerConfig>;
  byProject: Record<string, ProjectScopeData | undefined>;
  loading: boolean;
  error: string | undefined;
  pollHandle: number | undefined;

  startPolling: () => void;
  stopPolling: () => void;
  refreshSettings: () => Promise<void>;
  /** Pulls global config + per-project status. Idempotent. */
  refreshProject: (projectId: string | undefined) => Promise<void>;
  setMcpEnabled: (enabled: boolean) => Promise<void>;
  setMcpTruncation: (truncation: { enabled: boolean; maxChars: number }) => Promise<void>;
  upsertServer: (name: string, body: McpServerConfig) => Promise<void>;
  deleteServer: (name: string) => Promise<void>;
  probeServer: (name: string, projectId: string | undefined) => Promise<void>;
  /** Grant / revoke per-project stdio MCP trust. Refreshes the
   *  project after so the status entries flip from trust_required
   *  to connected (or back). */
  grantStdioTrust: (projectId: string) => Promise<void>;
  revokeStdioTrust: (projectId: string) => Promise<void>;
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
}

export const useMcpStore = create<McpState>((set, get) => ({
  settings: undefined,
  globalServers: {},
  byProject: {},
  loading: false,
  error: undefined,
  pollHandle: undefined,

  startPolling: () => {
    if (get().pollHandle !== undefined) return;
    let inFlight = false;
    const tick = (): void => {
      // Skip when the tab is in the background — don't burn cycles
      // (or our 30-call/min API budget) keeping a hidden tab warm.
      if (typeof document !== "undefined" && document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const projectIds = Object.keys(get().byProject);
          await get().refreshSettings();
          await Promise.all(projectIds.map((pid) => get().refreshProject(pid)));
        } finally {
          inFlight = false;
        }
      })();
    };
    void tick();
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    set({ pollHandle: handle });
  },

  stopPolling: () => {
    const handle = get().pollHandle;
    if (handle !== undefined) {
      window.clearInterval(handle);
      set({ pollHandle: undefined });
    }
  },

  refreshSettings: async () => {
    try {
      const r = await api.getMcpSettings();
      set((state) =>
        sameSettings(state.settings, r) ? { error: undefined } : { settings: r, error: undefined },
      );
    } catch (err) {
      // Network blips / 401 leave the prior `settings` value in place
      // so the badge doesn't flicker red on a transient error. The
      // unauthorized event handler in auth-store separately clears
      // the entire authed UI when 401 is real.
      if (!(err instanceof ApiError)) return;
      // 401 also leaves prior state — auth-store handles the actual
      // signout. Other API errors (5xx, schema) surface in `error`.
      if (err.status === 401) return;
      set({ error: describeError(err) });
    }
  },

  refreshProject: async (projectId) => {
    if (projectId === undefined) {
      // No active project — still refresh the global config + status
      // so the Settings tab works without a project selected.
      try {
        const list = await api.listMcpServers();
        set((state) =>
          stableJson(state.globalServers) === stableJson(list.servers)
            ? { error: undefined }
            : { globalServers: list.servers, error: undefined },
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        set({ error: describeError(err) });
      }
      return;
    }
    if (get().byProject[projectId] === undefined) set({ loading: true });
    try {
      const list = await api.listMcpServers(projectId);
      set((state) => {
        const entry: ProjectScopeData = {
          status: list.status,
          loadedAt: Date.now(),
        };
        if (list.stdioTrust !== undefined) entry.stdioTrust = list.stdioTrust;
        const sameGlobal = stableJson(state.globalServers) === stableJson(list.servers);
        const sameProject = sameProjectData(state.byProject[projectId], entry);
        return {
          loading: false,
          error: undefined,
          ...(sameGlobal ? {} : { globalServers: list.servers }),
          ...(sameProject ? {} : { byProject: { ...state.byProject, [projectId]: entry } }),
        };
      });
    } catch (err) {
      set({ loading: false, error: describeError(err) });
    }
  },

  setMcpEnabled: async (enabled) => {
    // Optimistic flip on the cached settings so the toggle feels
    // instant; the canonical value lands when the request resolves.
    const prior = get().settings;
    if (prior !== undefined) {
      set({ settings: { ...prior, enabled } });
    }
    try {
      const r = await api.setMcpEnabled(enabled);
      set({ settings: r, error: undefined });
    } catch (err) {
      // Revert on failure so the UI doesn't drift from the server.
      if (prior !== undefined) set({ settings: prior });
      set({ error: describeError(err) });
      throw err;
    }
  },

  setMcpTruncation: async (truncation) => {
    const prior = get().settings;
    if (prior !== undefined) {
      set({ settings: { ...prior, truncation } });
    }
    try {
      const r = await api.setMcpTruncation(truncation);
      set({ settings: r, error: undefined });
    } catch (err) {
      if (prior !== undefined) set({ settings: prior });
      set({ error: describeError(err) });
      throw err;
    }
  },

  upsertServer: async (name, body) => {
    try {
      await api.upsertMcpServer(name, body);
      // Server-side reloadGlobal() runs inside the route — re-pull
      // both global + per-project so status reflects the new
      // connection state. We refresh every cached project because a
      // new global server affects all of them.
      await Promise.all([
        get().refreshSettings(),
        ...Object.keys(get().byProject).map((pid) => get().refreshProject(pid)),
      ]);
    } catch (err) {
      set({ error: describeError(err) });
      throw err;
    }
  },

  deleteServer: async (name) => {
    try {
      await api.deleteMcpServer(name);
      await Promise.all([
        get().refreshSettings(),
        ...Object.keys(get().byProject).map((pid) => get().refreshProject(pid)),
      ]);
    } catch (err) {
      set({ error: describeError(err) });
      throw err;
    }
  },

  probeServer: async (name, projectId) => {
    try {
      await api.probeMcpServer(name, projectId);
      await Promise.all([get().refreshSettings(), get().refreshProject(projectId)]);
    } catch (err) {
      set({ error: describeError(err) });
      throw err;
    }
  },

  grantStdioTrust: async (projectId) => {
    try {
      await api.grantStdioMcpTrust(projectId);
      // Re-pull so status flips trust_required → connected for the
      // gated entries the route just retried.
      await get().refreshProject(projectId);
    } catch (err) {
      set({ error: describeError(err) });
      throw err;
    }
  },

  revokeStdioTrust: async (projectId) => {
    try {
      await api.revokeStdioMcpTrust(projectId);
      // Server unloads the entire project pool on revoke; refresh
      // pulls the post-revoke state (status: trust_required for
      // stdio entries; remote entries re-connecting).
      await get().refreshProject(projectId);
    } catch (err) {
      set({ error: describeError(err) });
      throw err;
    }
  },
}));
