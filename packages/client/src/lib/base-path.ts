const RAW_BUILD_BASE = import.meta.env?.BASE_URL ?? "/";

function normalizedBase(value: string): string {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function runtimeBasePath(): string | undefined {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") {
    return undefined;
  }
  const value = document.querySelector<HTMLMetaElement>('meta[name="pi-forge-base-path"]')?.content;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Prefer the server-injected runtime base path (derived from
 * X-Forwarded-Prefix) so one normal `/` build can run under a dashboard path
 * proxy like `/apps/pi-forge/`. Fall back to Vite's build-time base for static
 * hosts that still choose to bake the base path into the client bundle.
 */
export const appBasePath = normalizedBase(runtimeBasePath() ?? RAW_BUILD_BASE);

export function appUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${appBasePath}${suffix}`;
}

export const serviceWorkerRuntimeCompatible = appBasePath === normalizedBase(RAW_BUILD_BASE);

export function appResourceUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  // Leave absolute and browser-native resource URLs alone. Prefix only
  // origin-root-relative server URLs such as /cache/logos/... so they stay
  // inside a path-proxied deployment like /apps/pi-forge/.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
  if (url.startsWith("/")) return appUrl(url);
  return url;
}
