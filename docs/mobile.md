# Mobile

pi-forge is an installable PWA with a mobile-tuned chat surface —
talk to the agent and monitor what it's doing from your phone.

## What works on mobile

The phone surface is **chat + project monitoring**:

- Send prompts, watch the streaming reply
- Switch projects and sessions via the slide-in drawer
- Slash commands and `@` file references with phone-tuned popovers
- Attach photos from gallery / camera, or files from the system file
  manager
- Abort an in-flight agent run

Hidden (and unmounted, not just `display: none`) on mobile so they
don't load CodeMirror or hold a server-side PTY:

- File browser tree
- Per-turn diff panel
- Git panel
- File editor
- Integrated terminal

To get the desktop layout on a phone, use your browser's **"Request
Desktop Site"** toggle — the mobile breakpoint reacts to viewport
width, not user-agent, so the layout snaps back to full desktop.

## Installing as a PWA

Once installed, pi-forge runs fullscreen with no browser chrome and
respects your phone's safe-area insets.

**iOS Safari.** First visit shows a hint: *"Install: tap Share, then
Add to Home Screen."* iOS doesn't fire `beforeinstallprompt` — there's
no Install button, only the Share-sheet flow. If you dismiss the hint,
reach the same flow via the share button (square with up-arrow).

**Android Chrome / Brave / Edge.** First visit shows a banner with an
**Install** button. If you dismiss it, install via the browser menu →
**Install app** (or **Add to Home Screen**).

## HTTPS is required for install (operator gotcha)

Both Chrome and Safari only treat a site as installable over **HTTPS**
(or `http://localhost`). A LAN-IP `http://` instance — including the
`npm run dev:remote` flow at `http://10.0.0.5:5173` — won't show an
install option even with a valid manifest and service worker.

Production deployments behind a TLS-terminating reverse proxy (Caddy,
nginx, Traefik) get install for free. For local testing, two paths:

- **ngrok** (easiest):

  ```bash
  npm run build
  HOST=127.0.0.1 UI_PASSWORD='your-pw' node packages/server/dist/index.js &
  ngrok http 3000
  ```

  Visit the `https://….ngrok.io` URL on your phone.

- **Chrome's insecure-origin-as-secure flag.** On the phone, visit
  `chrome://flags#unsafely-treat-insecure-origin-as-secure`, add your
  LAN URL, enable, restart Chrome. Brave has the same flag at
  `brave://flags`.

`npm run dev` / `dev:remote` also disables the service worker
(`devOptions: { enabled: false }` in `vite.config.ts`) so HMR works —
that's a second reason install won't work in dev. You need a
production build (`npm run build`) for the SW to be active.

## Mobile-specific behaviors

- **Enter inserts a newline.** Mobile virtual keyboards don't surface
  Shift, so the desktop "Shift+Enter for newline" rule is unusable.
  Send via the explicit Send button. The slash and `@` palettes still
  own Enter when open.
- **Keyboard auto-dismisses on send** so the streaming reply isn't
  hidden behind half a screen of keyboard.
- **Textarea auto-grows** with input, capped at 30 vh, then scrolls
  internally.
- **Composer rides above the keyboard** via the
  `interactive-widget=resizes-content` viewport hint — no JS, just
  CSS reacting to the shrunk visual viewport.
- **Attach button** (paperclip) opens a popover: **Photo** for
  gallery + camera, **File** for the system file manager.
- **Drawer.** Hamburger button at top-left, or swipe right from the
  left edge. Tap the backdrop or pick a project / session to close.
- **Theme-aware browser chrome** — Android Chrome's address bar
  follows the active theme via the `theme-color` meta tag, updated on
  every theme switch.
- **Background streaming.** If you close the tab mid-stream the agent
  keeps running server-side, but updates don't reach you until you
  reopen pi-forge (no push notifications).

## See also

- [`configuration.md`](./configuration.md) — env vars + CLI flags,
  including `MINIMAL_UI` which mirrors most mobile-mode hides for
  locked-down desktop deploys
- [`deployment.md`](./deployment.md) — TLS at a reverse proxy (the
  prerequisite for PWA install)
- [`packages/client/src/lib/theme.ts`](../packages/client/src/lib/theme.ts) — theme registry + `THEME_CHROME` table
- [`packages/client/src/components/InstallPrompt.tsx`](../packages/client/src/components/InstallPrompt.tsx) — install-banner component (iOS vs Android branching)
