import type { CSSProperties } from "react";
import type { AuthColorScheme } from "./api-client/types";

export type AuthColorStyle = CSSProperties & {
  "--auth-page-bg": string;
  "--auth-card-bg": string;
  "--auth-border": string;
  "--auth-text": string;
  "--auth-muted-text": string;
  "--auth-button-bg": string;
  "--auth-button-text": string;
  "--auth-button-hover-bg": string;
  "--auth-input-bg": string;
  "--auth-input-text": string;
  "--auth-placeholder-text": string;
};

function expandHex(hex: string): string {
  if (hex.length !== 4) return hex;
  const r = hex[1] ?? "0";
  const g = hex[2] ?? "0";
  const b = hex[3] ?? "0";
  return `#${r}${r}${g}${g}${b}${b}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const full = expandHex(hex).slice(1);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function readableText(preferred: string, background: string): string {
  if (contrast(preferred, background) >= 4.5) return preferred;
  return contrast("#000000", background) >= contrast("#ffffff", background) ? "#000000" : "#ffffff";
}

export function authColorStyle(scheme: AuthColorScheme | undefined): AuthColorStyle {
  const pageBackground = scheme?.pageBackground ?? "#0a0a0a";
  const cardBackground = scheme?.cardBackground ?? "#171717";
  const border = scheme?.border ?? "#262626";
  const text = scheme?.text ?? "#f5f5f5";
  const mutedText = scheme?.mutedText ?? "#a3a3a3";
  const buttonBackground = scheme?.buttonBackground ?? "#f5f5f5";
  const buttonText = scheme?.buttonText ?? "#171717";
  const buttonHoverBackground = scheme?.buttonHoverBackground ?? "#ffffff";
  const inputBackground = pageBackground;
  const inputText = readableText(text, inputBackground);
  const placeholderText = contrast(mutedText, inputBackground) >= 3 ? mutedText : inputText;

  return {
    "--auth-page-bg": pageBackground,
    "--auth-card-bg": cardBackground,
    "--auth-border": border,
    "--auth-text": text,
    "--auth-muted-text": mutedText,
    "--auth-button-bg": buttonBackground,
    "--auth-button-text": buttonText,
    "--auth-button-hover-bg": buttonHoverBackground,
    "--auth-input-bg": inputBackground,
    "--auth-input-text": inputText,
    "--auth-placeholder-text": placeholderText,
  };
}
