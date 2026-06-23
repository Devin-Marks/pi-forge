import type { ServerThemeColors, ServerThemeConfigResponse } from "./api-client";

const CSS_VAR_BY_KEY: Record<keyof ServerThemeColors, string> = {
  appBackground: "--forge-app-bg",
  panelBackground: "--forge-panel-bg",
  userBubbleBackground: "--forge-user-bubble-bg",
  assistantBubbleBackground: "--forge-assistant-bubble-bg",
  primaryText: "--forge-text-primary",
  secondaryText: "--forge-text-secondary",
  mutedText: "--forge-text-muted",
  highlightBackground: "--forge-highlight-bg",
  highlightText: "--forge-highlight-text",
  selectionBackground: "--forge-selection-bg",
};

export function applyServerTheme(theme: ServerThemeConfigResponse | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === undefined || !theme.enabled) {
    root.dataset.serverTheme = "off";
    for (const cssVar of Object.values(CSS_VAR_BY_KEY)) {
      root.style.removeProperty(cssVar);
    }
    return;
  }
  root.dataset.serverTheme = "on";
  for (const [key, cssVar] of Object.entries(CSS_VAR_BY_KEY)) {
    root.style.setProperty(cssVar, theme.colors[key as keyof ServerThemeColors]);
  }
}
