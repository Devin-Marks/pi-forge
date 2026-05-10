# Mobile

pi-forge ships as an **installable PWA** with a mobile-tuned chat
surface — talk to the agent and watch what it's doing from your
phone. This page covers what works on mobile, how to install pi-forge
as a home-screen app, and the operator gotchas (TLS requirement,
service worker behavior).

If you only ever use pi-forge on a desktop browser, you can skip this
page. Nothing in mobile mode changes the desktop experience.

---

## What works on mobile

The phone surface is **chat + project monitoring**. You can:

- Send prompts to the agent, watch the streaming reply
- Switch projects and sessions via the slide-in drawer
- Use slash commands and `@` file references with phone-tuned popovers
- Attach photos from gallery / camera, or files from the system file
  manager
- Abort an in-flight agent run

Hidden on mobile (still available on desktop):

- File browser tree
- Per-turn diff panel
- Git panel
- File editor (CodeMirror)
- Integrated terminal

The hidden surfaces are also **unmounted** on mobile, not just
hidden — so the editor's CodeMirror toolchain doesn't load and the
terminal doesn't allocate a server-side PTY for a panel you can't
see.

If you want the desktop layout on a phone (e.g. you have a tablet,
or you specifically need the terminal in a pinch), use your browser's
**"Request Desktop Site"** toggle. The mobile breakpoint reacts to
viewport width, not user-agent — flipping that switch makes the
browser report a desktop viewport, the layout snaps back to full
desktop UI, and everything works.

---

## Installing as a PWA

Once installed, pi-forge runs fullscreen with no browser chrome,
appears in your app drawer with the pi-forge icon, and respects your
phone's safe-area insets (notch, home indicator, gesture bar).

### iOS Safari

The first time you visit pi-forge on a phone, an install hint
appears at the top of the screen:

> Install: tap **Share**, then **Add to Home Screen**.

Follow the prompt. iOS PWAs run from the home icon as standalone
apps — the install hint hides automatically once you launch from
the icon.

If you dismissed the hint and want to install later: tap the Safari
share button (square with up-arrow) → **Add to Home Screen**. There's
no programmatic install on iOS — `beforeinstallprompt` doesn't fire
on Safari.

### Android Chrome / Brave / Edge

The first visit shows a banner with an **Install** button at the
top. Tap it → the browser's native install dialog confirms → the app
appears in your launcher.

If you dismissed the banner, install via the browser's own menu:
3-dot menu → **Install app** (or **Add to Home Screen** depending on
the browser).

---

## Operator gotcha: HTTPS is required for install

Both Android Chrome and iOS Safari only treat a site as installable
over **HTTPS** (or `http://localhost`). A pi-forge instance reachable
over plain `http://` on a LAN IP — for example, the dev `npm run
dev:remote` flow at `http://10.0.0.5:5173` — will not show an install
option, even when the manifest and service worker are otherwise
correct.

In production this is automatic: the documented Docker deployment
sits behind a TLS-terminated reverse proxy (Caddy, nginx, Traefik)
and the install path works without further configuration.

For local PWA testing without a real cert, two reasonable paths:

- **ngrok** (easiest): build the production bundle, serve it from
  the Fastify server, expose with HTTPS via ngrok.

  ```bash
  npm run build
  HOST=127.0.0.1 UI_PASSWORD='your-pw' node packages/server/dist/index.js &
  ngrok http 3000
  ```

  Visit the `https://….ngrok.io` URL on your phone — Android's
  install option appears in the menu and our banner fires.

- **Chrome's insecure-origin-as-secure flag**: on the phone, visit
  `chrome://flags#unsafely-treat-insecure-origin-as-secure`, add
  your LAN IP (`http://10.0.0.5:3000`), enable, restart Chrome.
  Then run the production bundle the same way as above. Brave has
  the same flag at `brave://flags`.

Note that `npm run dev` / `dev:remote` also disables the service
worker (`devOptions: { enabled: false }` in `vite.config.ts`) so HMR
keeps working — that's a second reason install won't work in dev.
You need a production build (`npm run build`) for the SW to be
active.

---

## Mobile-specific behaviors

A few phone-only quirks worth knowing about as a user:

- **Enter inserts a newline**, doesn't submit. Mobile virtual
  keyboards don't surface Shift conveniently, so the desktop
  "Shift+Enter for newline" rule is unworkable. Send is the
  explicit Send button. The slash and `@` palettes still own
  Enter when open (Enter picks the highlighted suggestion).

- **Keyboard auto-dismisses on send** so the streaming reply isn't
  eaten by half a screen of keyboard. Tap the textarea again to
  bring it back for the next message.

- **Textarea auto-grows** with what you type, capped at 30% of the
  viewport height, then scrolls internally past that.

- **Chat composer rides above the keyboard.** When the keyboard
  appears, the visual viewport shrinks (via the `interactive-
  widget=resizes-content` viewport hint) and the composer floats
  to its top. No JS gymnastics — it's just CSS doing the right
  thing once the meta tag is set.

- **Attach button** (paperclip) opens a small popover with two
  choices: **Photo** opens the gallery + camera picker; **File**
  opens the system file manager. The popover collapses two
  separate buttons into one entry-point so the textarea keeps its
  width on a 360 px screen.

- **Drawer + sidebar.** The project / session sidebar is a slide-in
  drawer behind a hamburger button at the top-left. Tap the
  hamburger or swipe right from the very left edge of the screen
  to open it. Tap the backdrop or pick a project / session to
  close.

- **Theme-aware browser chrome.** Android Chrome paints its
  address bar with our `theme-color` meta tag. The tag is updated
  whenever you switch themes in Settings → General, so the chrome
  blends with the active theme rather than always being dark.

---

## Not (yet) supported on mobile

- **Native iOS / Android wrapper** (Capacitor, Tauri Mobile). pi-
  forge is web-only. The PWA install path approximates a native
  app for most use cases.
- **Push notifications.** No "agent finished" alerts when the tab
  is backgrounded. Deferred to post-v1.
- **Background sync.** If you close the tab mid-stream, the agent
  keeps running on the server but you won't see updates until you
  reopen pi-forge.

---

## See also

- [`docs/configuration.md`](./configuration.md) — environment
  variables and CLI flags (including `MINIMAL_UI`, which mirrors
  most of the mobile-mode hides for locked-down desktop deploys)
- [`docs/deployment.md`](./deployment.md) — production deploy with
  TLS at a reverse proxy (the prerequisite for PWA install in the
  field)
- [`packages/client/src/lib/theme.ts`](../packages/client/src/lib/theme.ts)
  — theme registry + the `THEME_CHROME` table that drives the
  per-theme `theme-color` meta tag
- [`packages/client/src/components/InstallPrompt.tsx`](../packages/client/src/components/InstallPrompt.tsx)
  — the install banner component, including the iOS-vs-Android
  branching logic
