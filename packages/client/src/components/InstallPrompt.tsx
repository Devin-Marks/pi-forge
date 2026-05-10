import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";
import { useIsMobile } from "../lib/use-is-mobile";

/**
 * "Install pi-forge as an app" banner — shown on mobile, dismissable,
 * with platform-specific behavior:
 *
 *   - **Android Chrome / Edge / Samsung Internet**: listens for the
 *     `beforeinstallprompt` event, captures the deferred prompt, and
 *     a tap on "Install" calls `prompt()` + `userChoice`. Browser
 *     suppresses the event after install (or after the user has
 *     dismissed enough times — heuristic), so we don't have to track
 *     install state ourselves.
 *
 *   - **iOS Safari**: doesn't fire `beforeinstallprompt`; PWA install
 *     is "Tap Share → Add to Home Screen" by hand. We render a hint
 *     with the share glyph instead of an Install button.
 *
 *   - **Already-installed PWA**: hidden via the standalone-mode
 *     check (`display-mode: standalone` media query OR iOS's
 *     `navigator.standalone`). Once launched from the home icon, no
 *     point nagging.
 *
 * Dismissal persists in localStorage so the banner doesn't re-appear
 * after every reload. There's no "remind me later" — the user can
 * always reach Add to Home Screen through the browser's own menu.
 */

const DISMISS_KEY = "pi-forge/install-prompt-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari sets a non-standard `navigator.standalone` (true when
  // launched from the home icon). Other browsers respect the CSS
  // `display-mode: standalone` media query.
  if ((window.navigator as { standalone?: boolean }).standalone === true) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // Modern iOS Safari + Edge/Firefox iOS all share WebKit; the UA
  // pattern is stable enough for "show iOS install hint" gating.
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallPrompt(): React.JSX.Element | null {
  const isMobile = useIsMobile();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | undefined>(undefined);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(DISMISS_KEY) === "true";
  });
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return; // already installed
    if (dismissed) return;

    const onBeforeInstall = (e: Event): void => {
      e.preventDefault(); // suppress the browser's own mini-bar
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    // iOS doesn't fire beforeinstallprompt — show the hint when
    // mobile + iOS + not standalone. Delay so the banner doesn't
    // race the first paint and feel intrusive.
    if (isIOS() && isMobile) {
      const timer = window.setTimeout(() => setIosHint(true), 1500);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      };
    }
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, [isMobile, dismissed]);

  const dismiss = (): void => {
    setDismissed(true);
    setDeferred(undefined);
    setIosHint(false);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // private mode — dismissal won't persist, accept that
    }
  };

  const onInstall = async (): Promise<void> => {
    if (deferred === undefined) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(undefined);
    if (choice.outcome === "accepted") dismiss();
  };

  if (!isMobile || dismissed || isStandalone()) return null;
  // Render only when we have something to show: a deferred Android
  // prompt OR the iOS hint flag is on.
  if (deferred === undefined && !iosHint) return null;

  return (
    <div className="border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <div className="min-w-0 flex-1">
          {deferred !== undefined ? (
            <span>Install pi-forge as an app for a fullscreen experience.</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1">
              Install: tap <Share size={14} className="inline shrink-0 text-neutral-400" /> Share,
              then <span className="font-medium">Add to Home Screen</span>.
            </span>
          )}
        </div>
        {deferred !== undefined && (
          <button
            type="button"
            onClick={() => void onInstall()}
            className="shrink-0 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-neutral-200"
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
