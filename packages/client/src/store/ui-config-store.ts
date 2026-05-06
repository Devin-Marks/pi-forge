import { create } from "zustand";
import { api, ApiError } from "../lib/api-client";

/**
 * Server-driven UI configuration. Fetched once at boot from the
 * public `/api/v1/ui-config` endpoint (no auth) and held in this
 * store for the rest of the session. The values it returns are
 * effectively constants for the lifetime of the page — they only
 * change when the operator restarts the server with different env
 * vars.
 *
 * Components that need to gate UI on a flag should read `minimal`
 * from this store. Treat `loaded === false` as "still booting" —
 * during that window we render the default (full) UI rather than
 * flashing the minimal layout while we wait.
 */
interface UiConfigState {
  loaded: boolean;
  /** True when MINIMAL_UI is set on the server — see config.ts. */
  minimal: boolean;
  /** Absolute workspace root reported by the server. */
  workspaceRoot: string;
  /** Server build version (mirrors packages/server's package.json). */
  version: string;
  /**
   * True when the server supports the browser password-change flow.
   * Defaults to true so the General settings tab still shows the
   * password section before /ui-config has loaded — better than
   * flashing the form away on first paint.
   */
  passwordAuthEnabled: boolean;
  /** Last load error (sticky until a retry succeeds), for diagnostics. */
  error: string | undefined;
  load: () => Promise<void>;
}

export const useUiConfigStore = create<UiConfigState>((set) => ({
  loaded: false,
  minimal: false,
  workspaceRoot: "",
  version: "",
  passwordAuthEnabled: true,
  error: undefined,
  load: async () => {
    try {
      const cfg = await api.uiConfig();
      set({
        loaded: true,
        minimal: cfg.minimal,
        workspaceRoot: cfg.workspaceRoot,
        version: cfg.version,
        passwordAuthEnabled: cfg.passwordAuthEnabled,
        error: undefined,
      });
    } catch (err) {
      // Failure here is non-fatal — we just stay in the default
      // (full) UI so the user can still use the app. Surface in
      // dev tools so a misconfigured server doesn't fail silently.
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      if (typeof console !== "undefined") {
        console.warn("[ui-config] load failed:", code);
      }
      set({ loaded: true, error: code });
    }
  },
}));
