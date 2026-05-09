import { useEffect, useState } from "react";

/**
 * Reactive viewport-width breakpoint hook.
 *
 * Returns `true` when the viewport is narrower than Tailwind's `md`
 * breakpoint (< 768 px). Tablets in portrait (typically ≥ 768 px) are
 * intentionally treated as desktop — the layout collapses only for
 * actual phone-sized viewports.
 *
 * Pure client-side `matchMedia` (not server-supplied) so it tracks
 * orientation changes, browser-window resizes, and the "Request
 * Desktop Site" toggle: when the user flips that switch in mobile
 * Safari/Chrome, the browser reports a desktop viewport width and the
 * desktop layout re-renders for free.
 *
 * SSR-safe: returns `false` on the first render when `window` isn't
 * available, then re-renders with the real value after mount.
 */
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Initial sync in case the value changed between SSR-default and mount.
    setIsMobile(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
