import { create } from "zustand";

/**
 * Identifier used both as the `data-theme` attribute value on
 * `<html>` and as the localStorage key payload. Adding a theme is a
 * three-step change: add an id here, add a CSS rule in index.css,
 * and (optionally) tag it light vs dark in {@link THEME_DEFS}.
 */
export type ThemeId =
  | "dark"
  | "light"
  | "dracula"
  | "solarized-dark"
  | "catppuccin-mocha"
  | "high-contrast";

export interface ThemeDef {
  id: ThemeId;
  /** User-facing label in the picker. */
  label: string;
  /** Drives CodeMirror theme + xterm color choices. */
  mode: "dark" | "light";
}

export const THEME_DEFS: ThemeDef[] = [
  { id: "dark", label: "Dark (default)", mode: "dark" },
  { id: "light", label: "Light", mode: "light" },
  { id: "dracula", label: "Dracula", mode: "dark" },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark" },
  { id: "high-contrast", label: "High Contrast", mode: "dark" },
];

const STORAGE_KEY = "forge.theme";

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEME_DEFS.some((t) => t.id === v);
}

/**
 * Read the persisted theme synchronously. Used at boot (before
 * React mounts) so we paint the correct chrome on first frame and
 * avoid a dark→light flash.
 */
export function readPersistedTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(raw)) return raw;
  } catch {
    // private mode / disabled storage — fall through
  }
  return "dark";
}

function writePersistedTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore — runtime change still applies
  }
}

/**
 * Per-theme `theme-color` for the browser chrome (Android Chrome
 * paints the address bar with this; iOS PWA standalone mode uses
 * it for the status-bar surround). Each value is the theme's
 * `--color-neutral-950` from index.css — the same color the
 * application header renders against, so the chrome blends into
 * the app surface.
 *
 * Resolved via this lookup table (NOT readCssVar) because the meta
 * tag needs to update synchronously on theme change before the next
 * paint — reading from getComputedStyle right after applyTheme can
 * race the browser's style recalc and return the previous theme's
 * value. Hard-coded values stay in sync via the CSS-in-source-of-
 * truth review checklist when adding a theme.
 */
const THEME_CHROME: Record<ThemeId, string> = {
  dark: "#0a0a0a",
  light: "#ffffff",
  dracula: "#191a21",
  "solarized-dark": "#002b36",
  "catppuccin-mocha": "#11111b",
  "high-contrast": "#000000",
};

function syncThemeColorMeta(id: ThemeId): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  meta.setAttribute("content", THEME_CHROME[id] ?? THEME_CHROME.dark);
}

/**
 * Apply a theme to the document. Idempotent — safe to call from
 * both the boot path and the picker. Updates `<html data-theme>`
 * which the CSS in index.css uses as a selector to switch the
 * Tailwind neutral palette at runtime, and syncs the
 * `<meta name="theme-color">` tag so the browser chrome blends
 * into the new palette.
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = id;
  syncThemeColorMeta(id);
}

/** Synchronous boot helper called before React mounts. */
export function bootTheme(): ThemeId {
  const id = readPersistedTheme();
  applyTheme(id);
  return id;
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

/**
 * Hook for components that need the current theme reactively
 * (e.g. CodeMirror picking dark vs light, xterm picking colors).
 * `setTheme` writes to storage AND updates the DOM, so components
 * can call it without juggling persistence themselves.
 */
export const useThemeStore = create<ThemeState>((set) => ({
  theme: readPersistedTheme(),
  setTheme: (id) => {
    applyTheme(id);
    writePersistedTheme(id);
    set({ theme: id });
  },
}));

/** Look up the def for a given id; falls back to the dark default. */
export function themeDef(id: ThemeId): ThemeDef {
  return THEME_DEFS.find((t) => t.id === id) ?? THEME_DEFS[0]!;
}

/**
 * Resolve an `--pi-*` CSS variable to its computed value. Used by
 * non-Tailwind surfaces (xterm) that need the literal hex string,
 * not a `var(...)` reference.
 */
export function readCssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}
