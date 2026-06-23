import { authColorStyle } from "../packages/client/src/lib/auth-colors";
import type { AuthColorScheme } from "../packages/client/src/lib/api-client/types";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const whiteScheme: AuthColorScheme = {
  pageBackground: "#ffffff",
  cardBackground: "#ffffff",
  border: "#d4d4d4",
  text: "#ffffff",
  mutedText: "#737373",
  buttonBackground: "#111827",
  buttonText: "#ffffff",
  buttonHoverBackground: "#374151",
};
const white = authColorStyle(whiteScheme);
assert(
  "white auth card derives visible input text",
  white["--auth-input-text"] === "#000000",
  String(white["--auth-input-text"]),
);
assert(
  "white auth card keeps input background on page color",
  white["--auth-input-bg"] === "#ffffff",
);

const blueCardWhitePageScheme: AuthColorScheme = {
  pageBackground: "#ffffff",
  cardBackground: "#2563eb",
  border: "#1d4ed8",
  text: "#ffffff",
  mutedText: "#dbeafe",
  buttonBackground: "#2563eb",
  buttonText: "#ffffff",
  buttonHoverBackground: "#1d4ed8",
};
const blueCardWhitePage = authColorStyle(blueCardWhitePageScheme);
assert(
  "blue card with white page uses page color for input background",
  blueCardWhitePage["--auth-input-bg"] === "#ffffff",
  String(blueCardWhitePage["--auth-input-bg"]),
);
assert(
  "blue card with white page derives readable input text",
  blueCardWhitePage["--auth-input-text"] === "#000000",
  String(blueCardWhitePage["--auth-input-text"]),
);

const darkBlueScheme: AuthColorScheme = {
  pageBackground: "#08111f",
  cardBackground: "#102033",
  border: "#2563eb",
  text: "#f8fafc",
  mutedText: "#cbd5e1",
  buttonBackground: "#2563eb",
  buttonText: "#082f49",
  buttonHoverBackground: "#7dd3fc",
};
const darkBlue = authColorStyle(darkBlueScheme);
assert(
  "dark blue page preserves configured readable input text",
  darkBlue["--auth-input-text"] === "#f8fafc",
  String(darkBlue["--auth-input-text"]),
);

const defaults = authColorStyle(undefined);
assert(
  "default input background matches existing dark field",
  defaults["--auth-input-bg"] === "#0a0a0a",
);
assert("default input text remains light", defaults["--auth-input-text"] === "#f5f5f5");

if (failures > 0) process.exit(1);
console.log("\nPASS  test-auth-colors");
