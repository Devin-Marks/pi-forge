import { useMemo, useState, type FormEvent } from "react";
import { authColorStyle } from "../lib/auth-colors";
import { useAuthStore } from "../store/auth-store";
import { useUiConfigStore } from "../store/ui-config-store";

const ALLOWED_BANNER_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DIV",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SPAN",
  "STRONG",
  "U",
  "UL",
]);
const DROP_WITH_CONTENT_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

function sanitizeBannerHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cleanNode = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      if (DROP_WITH_CONTENT_TAGS.has(el.tagName)) {
        el.remove();
        continue;
      }
      if (!ALLOWED_BANNER_TAGS.has(el.tagName)) {
        el.replaceWith(doc.createTextNode(el.textContent ?? ""));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (el.tagName === "A" && name === "href") {
          try {
            const url = new URL(attr.value, window.location.origin);
            if (!["http:", "https:", "mailto:"].includes(url.protocol)) el.removeAttribute(name);
          } catch {
            el.removeAttribute(name);
          }
          continue;
        }
        if (el.tagName === "A" && ["title", "target", "rel"].includes(name)) continue;
        el.removeAttribute(name);
      }
      if (el.tagName === "A" && el.getAttribute("href") !== null) {
        el.setAttribute("rel", "noopener noreferrer");
      }
      cleanNode(el);
    }
  };
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

export function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useAuthStore((s) => s.login);
  const ldapEnabled = useAuthStore((s) => s.ldapEnabled);
  const pending = useAuthStore((s) => s.loginPending);
  const error = useAuthStore((s) => s.loginError);
  const authBannerText = useUiConfigStore((s) => s.authBannerText);
  const authBannerHtml = useUiConfigStore((s) => s.authBannerHtml);
  const authLogoUrl = useUiConfigStore((s) => s.authLogoUrl);
  const authColorScheme = useUiConfigStore((s) => s.authColorScheme);
  const colors = useMemo(() => authColorStyle(authColorScheme), [authColorScheme]);
  const sanitizedBannerHtml = useMemo(
    () => (authBannerText && authBannerHtml ? sanitizeBannerHtml(authBannerText) : ""),
    [authBannerHtml, authBannerText],
  );
  const hasAuthBanner = authBannerText !== undefined && authBannerText.length > 0;

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (password.length === 0) return;
    if (ldapEnabled && username.trim().length === 0) return;
    void login(password, ldapEnabled ? username.trim() : undefined);
  };

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[var(--auth-page-bg)] px-4 py-8 text-[var(--auth-text)]"
      style={colors}
    >
      <div className="flex w-full max-w-[1536px] flex-col items-center gap-3">
        <form
          onSubmit={onSubmit}
          className="w-full max-w-sm space-y-4 rounded-lg border border-[var(--auth-border)] bg-[var(--auth-card-bg)] p-6 text-[var(--auth-text)] shadow-lg"
        >
          <header className="space-y-1">
            <div className="flex items-center gap-2">
              <img
                src={authLogoUrl ?? "/icons/icon.svg"}
                alt=""
                className="max-h-6 max-w-24 object-contain"
                aria-hidden="true"
              />
              <h1 className="text-xl font-semibold tracking-tight">pi-forge</h1>
            </div>
            <p className="text-sm text-[var(--auth-muted-text)]">
              {ldapEnabled
                ? "Sign in with your LDAP account."
                : "Enter the pi-forge password to continue."}
            </p>
          </header>
          {ldapEnabled && (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-[var(--auth-text)]">Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                className="w-full rounded-md border border-[var(--auth-border)] bg-[var(--auth-input-bg)] px-3 py-2 text-sm text-[var(--auth-input-text)] caret-[var(--auth-input-text)] outline-none placeholder:text-[var(--auth-placeholder-text)] focus:border-[var(--auth-muted-text)] [-webkit-text-fill-color:var(--auth-input-text)]"
              />
            </label>
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--auth-text)]">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={!ldapEnabled}
              autoComplete="current-password"
              className="w-full rounded-md border border-[var(--auth-border)] bg-[var(--auth-input-bg)] px-3 py-2 text-sm text-[var(--auth-input-text)] caret-[var(--auth-input-text)] outline-none placeholder:text-[var(--auth-placeholder-text)] focus:border-[var(--auth-muted-text)] [-webkit-text-fill-color:var(--auth-input-text)]"
            />
          </label>
          {error !== undefined && (
            <p role="alert" className="text-sm text-red-400">
              {error === "invalid_password"
                ? ldapEnabled
                  ? "Incorrect username, password, or LDAP group."
                  : "Incorrect password."
                : error === "username_required"
                  ? "Username is required."
                  : `Login failed: ${error}`}
            </p>
          )}
          <button
            type="submit"
            disabled={
              pending || password.length === 0 || (ldapEnabled && username.trim().length === 0)
            }
            className="w-full rounded-md bg-[var(--auth-button-bg)] px-3 py-2 text-sm font-medium text-[var(--auth-button-text)] transition hover:bg-[var(--auth-button-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {hasAuthBanner &&
          (authBannerHtml ? (
            <section
              className="w-fit max-w-full whitespace-normal break-words rounded-lg border border-[var(--auth-border)] bg-[var(--auth-card-bg)] p-4 text-sm text-[var(--auth-text)] shadow-lg [&_*]:max-w-none [&_a]:text-sky-300 [&_a]:underline [&_code]:rounded [&_code]:bg-[var(--auth-page-bg)] [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:max-w-none [&_pre]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-5"
              aria-label="Authentication notice"
              // AUTH_BANNER_HTML is operator opt-in and still sanitized
              // above; plain text uses React escaping + whitespace-preserve.
              dangerouslySetInnerHTML={{ __html: sanitizedBannerHtml }}
            />
          ) : (
            <section
              className="w-fit max-w-full whitespace-pre-wrap break-words rounded-lg border border-[var(--auth-border)] bg-[var(--auth-card-bg)] p-4 text-sm text-[var(--auth-text)] shadow-lg"
              aria-label="Authentication notice"
            >
              {authBannerText}
            </section>
          ))}
      </div>
    </main>
  );
}
