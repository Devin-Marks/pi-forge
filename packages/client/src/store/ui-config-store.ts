import { create } from "zustand";
import { api, ApiError, type ServerThemeConfigResponse } from "../lib/api-client";
import type { AuthColorScheme } from "../lib/api-client/types";
import { applyServerTheme } from "../lib/server-theme";

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
  /**
   * True when the server has session orchestration available
   * (enabled by default unless disabled by config, and not MINIMAL_UI).
   * Default false until /ui-config loads so older servers that do not
   * expose the field keep the old hidden posture.
   */
  orchestrationEnabled: boolean;
  /** Global server-side color overrides for broad UI surfaces. */
  serverTheme: ServerThemeConfigResponse | undefined;
  /** Optional public banner shown below the login prompt. */
  authBannerText: string | undefined;
  /** True when the banner should render as sanitized HTML. */
  authBannerHtml: boolean;
  /** Logo URL handling mode selected by the server. */
  logoUrlMode: "cache" | "direct";
  /** Optional login/auth page color scheme. */
  authColorScheme: AuthColorScheme | undefined;
  /** Optional URL for the login/auth logo (same-origin cache URL unless direct mode is enabled). */
  authLogoUrl: string | undefined;
  /** Optional URL for the app header logo in dark-mode themes. */
  appLogoDarkUrl: string | undefined;
  /** Optional URL for the app header logo in light-mode themes. */
  appLogoLightUrl: string | undefined;
  /** Last load error (sticky until a retry succeeds), for diagnostics. */
  error: string | undefined;
  load: () => Promise<void>;
  setServerTheme: (theme: ServerThemeConfigResponse) => void;
}

export const useUiConfigStore = create<UiConfigState>((set) => ({
  loaded: false,
  minimal: false,
  workspaceRoot: "",
  version: "",
  passwordAuthEnabled: true,
  orchestrationEnabled: false,
  serverTheme: undefined,
  authBannerText: undefined,
  authBannerHtml: false,
  logoUrlMode: "cache",
  authColorScheme: undefined,
  authLogoUrl: undefined,
  appLogoDarkUrl: undefined,
  appLogoLightUrl: undefined,
  error: undefined,
  setServerTheme: (theme) => {
    applyServerTheme(theme);
    set({ serverTheme: theme });
  },
  load: async () => {
    try {
      const cfg = await api.uiConfig();
      applyServerTheme(cfg.serverTheme);
      set({
        loaded: true,
        minimal: cfg.minimal,
        workspaceRoot: cfg.workspaceRoot,
        version: cfg.version,
        passwordAuthEnabled: cfg.passwordAuthEnabled,
        orchestrationEnabled: cfg.orchestrationEnabled,
        serverTheme: cfg.serverTheme,
        authBannerText: cfg.authBannerText,
        authBannerHtml: cfg.authBannerHtml,
        logoUrlMode: cfg.logoUrlMode,
        authColorScheme: cfg.authColorScheme,
        authLogoUrl: cfg.authLogoUrl,
        appLogoDarkUrl: cfg.appLogoDarkUrl,
        appLogoLightUrl: cfg.appLogoLightUrl,
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
