import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Parse the `VITE_DEV_ALLOWED_HOSTS` env into the shape Vite's
 * `server.allowedHosts` expects. Returns `undefined` when unset (Vite
 * falls back to its default allowlist), `true` for `"all"` (disable
 * the check entirely), or a string[] for a comma-separated list. See
 * the comment on the `server.allowedHosts` field below for the
 * security trade-offs of each shape.
 */
function parseAllowedHosts(raw: string | undefined): true | string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === "all") return true;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function devApiTarget(): string {
  const port = process.env.VITE_API_PORT ?? process.env.PORT ?? "3100";
  const host = process.env.VITE_API_HOST ?? "localhost";
  return `http://${host}:${port}`;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "icons/icon.svg",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/icon-maskable-512.png",
        "offline.html",
      ],
      manifest: {
        name: "pi-forge",
        short_name: "pi-forge",
        description:
          "Self-hosted browser workbench for the pi coding agent — chat with the agent against your code, browse files, run a terminal, review diffs, all from one tab.",
        // theme_color is the static fallback used during PWA install
        // and at first paint before applyTheme() runs in the React
        // boot path. Once the React app mounts, theme.ts swaps the
        // <meta name="theme-color"> tag to match the user's chosen
        // theme — see THEME_CHROME in lib/theme.ts. Keep this in
        // sync with the dark theme's --color-neutral-950.
        theme_color: "#0a0a0a",
        // Splash screen background (Android shows a solid-color
        // splash before the SW serves index.html). Kept dark; light-
        // theme users will get a brief flash on cold launch which is
        // an acceptable trade-off vs forcing a per-theme manifest
        // (which would require a rebuild per user preference).
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "any",
        lang: "en",
        // App-store-style categorization. Surfaced by Chrome's
        // install UI and by some app launchers / browser extensions
        // that index PWAs.
        categories: ["productivity", "developer"],
        // Raster PNGs for the standard install sizes (192/512 are the
        // PWA spec's recommended baseline) plus a dedicated maskable
        // 512×512 with the glyph rendered into the middle 80% of the
        // canvas — Android adaptive icons crop the outer 20% so a
        // full-bleed glyph would lose its edges. SVG kept as a
        // vector-quality fallback for browsers that prefer it
        // (Chrome/Edge/Firefox desktop will pick the SVG over the
        // rasters when both are advertised). iOS Safari uses the
        // apple-touch-icon link tag in index.html for home-screen
        // installs; the rasters above also serve that path.
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        // The shell + hashed assets are cached on install. Anything
        // under /api/v1/* is dynamic and should be network-first so we
        // never serve a stale session list. The /api/v1/sessions/:id/
        // /stream SSE endpoint is excluded — caching a streaming
        // response would break it.
        //
        // navigateFallback serves /index.html for SPA deep links while
        // online. When the SW can't reach the network at all (server
        // down, laptop offline, reverse proxy borked), the fetch
        // handler below catches the resulting failure and serves the
        // branded /offline.html instead — usable, in-theme, with a
        // reload button — rather than the browser's chromeless
        // "no-internet" page or the SPA shell with a red error banner.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/v1/"),
            handler: "NetworkOnly",
          },
          {
            // Catches navigation requests when both the network AND
            // the precached /index.html navigateFallback fail. In
            // practice this fires when the SW itself can't reach the
            // server (no network, server down) — workbox falls
            // through to the precache, and if THAT misses too the
            // request errors out. The handler returns the precached
            // /offline.html for any navigation request as a final
            // fallback. NetworkFirst with a short timeout so we don't
            // make the user wait for a network round-trip when the
            // network's clearly down.
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pi-navigation",
              networkTimeoutSeconds: 3,
              precacheFallback: { fallbackURL: "/offline.html" },
            },
          },
        ],
      },
      devOptions: {
        // Keep the service worker disabled in `npm run dev` so HMR
        // works normally; the SW only activates on the built bundle.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    // `VITE_DEV_ALLOWED_HOSTS` opens the dev server up to reverse-proxy
    // hostnames that Vite's default `allowedHosts` (localhost + LAN
    // IPs, the anti-DNS-rebinding allowlist) would otherwise block.
    // Needed when `npm run dev:remote` is fronted by a proxy serving a
    // public/internal hostname like `forgetest.example.com` — without
    // it Vite responds with `Blocked request. This host (...) is not
    // allowed.` and refuses to load the SPA.
    //
    // Three accepted shapes:
    //   - unset       → use Vite's default allowlist (safest)
    //   - "all"       → disable the check entirely (dev convenience;
    //                   ACCEPTS the DNS-rebinding risk — only use on
    //                   trusted networks)
    //   - "a.b,c.d"   → comma-separated explicit allowlist; whitespace
    //                   around entries is trimmed, empties dropped
    //
    // Production / built bundle is unaffected — this is dev-server only.
    allowedHosts: parseAllowedHosts(process.env.VITE_DEV_ALLOWED_HOSTS),
    proxy: {
      "/api": {
        // Root `npm run dev` / `dev:remote` pass the API server port through
        // PORT (default 3100). Mirror that default here instead of hardcoding
        // 3000, otherwise direct `npm run dev -w packages/client` proxies API/SSE/WS traffic to the
        // wrong backend. VITE_API_PORT / VITE_API_HOST let unusual local setups
        // override the target without changing the server's own PORT/HOST.
        target: devApiTarget(),
        changeOrigin: true,
        // Forward WebSocket upgrades for `/api/v1/terminal` (Phase 11).
        // Without `ws: true`, Vite falls through to its own ws server
        // and the upgrade handshake fails.
        ws: true,
      },
      "/cache": {
        // Custom logos are cached and served by the Fastify backend under
        // /cache/logos/*. In dev, the browser origin is Vite (:5173), so
        // same-origin image URLs from /api/v1/ui-config must proxy here too.
        target: devApiTarget(),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
