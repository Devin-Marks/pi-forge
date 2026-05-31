# wterm Evaluation for pi-forge Integrated Terminal

Date: 2026-05-31

## Recommendation

Do **not** replace pi-forge's current `node-pty` + custom WebSocket route + `xterm.js` client stack with `wterm` now. `wterm` is promising, especially for DOM-native selection, browser find, and accessibility, but it is a young client-side terminal emulator and would not replace the hardest pi-forge-specific parts of the stack: PTY lifecycle, auth, tab reattach, output replay, idle reap, and project scoping.

Best path: keep `xterm.js` as the production terminal. Revisit `wterm` after it has a longer release/consumer history, or run a separate feature-flagged spike only if pi-forge prioritizes DOM text selection/browser-find/screen-reader behavior over mature `xterm.js` feature parity.

## Current pi-forge requirements

Current implementation references:

- Server PTY lifecycle: `packages/server/src/pty-manager.ts`
- Terminal WebSocket route: `packages/server/src/routes/terminal.ts`
- Browser terminal UI: `packages/client/src/components/TerminalPanel.tsx`
- Persisted tab metadata: `packages/client/src/store/terminal-store.ts`
- Integration tests: `tests/test-terminal.ts`, `tests/test-pty-reattach.ts`

Important current guarantees:

- One `node-pty` per browser terminal tab, scoped to a project.
- Browser WebSocket auth supports `?token=` because browser `WebSocket` cannot set `Authorization` headers.
- Stable `tabId` enables reattach after reload/network drops.
- Detached PTYs survive briefly, replay a rolling 256 KB output buffer, then idle-reap.
- One active WebSocket sink per PTY; newer same-`tabId` attaches displace older sockets.
- Client sends JSON control frames for input and resize; server sends PTY output as raw binary frames.
- Client uses `@xterm/addon-fit` for resize and `@xterm/addon-web-links` for URL detection.
- Client keeps xterm instances outside Zustand state so scrollback survives panel/tab remounts.

## What wterm is

`wterm` is a browser terminal emulator from `vercel-labs/wterm`. Its README describes a Zig/WASM terminal core and DOM renderer, with packages for `@wterm/core`, `@wterm/dom`, `@wterm/react`, and optional `@wterm/ghostty` for fuller VT emulation. The stated benefits are DOM rendering, native text selection, clipboard, browser find, screen-reader support, dirty-row rendering, alternate screen, configurable scrollback, 24-bit color, auto-resize, and a WebSocket transport. Sources: [wterm README](https://github.com/vercel-labs/wterm/blob/main/README.md), [`@wterm/core` README](https://github.com/vercel-labs/wterm/blob/main/packages/%40wterm/core/README.md), [`@wterm/dom` README](https://github.com/vercel-labs/wterm/blob/main/packages/%40wterm/dom/README.md), [`@wterm/react` README](https://github.com/vercel-labs/wterm/blob/main/packages/%40wterm/react/README.md).

`npm view` on 2026-05-31 showed `@wterm/dom`, `@wterm/react`, and `@wterm/ghostty` at `0.3.0`; `@wterm/dom` unpacked size is about 109 KB, `@wterm/react` about 28 KB, and `@wterm/ghostty` about 475 KB. The npm publish history began on 2026-04-14 and reached 0.3.0 by 2026-04-30.

## Compatibility matrix

| Area | Fit | Evidence and notes |
|---|---:|---|
| Browser terminal | Good | `@wterm/dom` and `@wterm/react` provide browser/React terminal APIs with `write`, `resize`, `focus`, `onData`, `onResize`, and embedded WASM by default. |
| Server PTY lifecycle | No replacement | `wterm` is a client emulator/transport layer. pi-forge would still need `node-pty`, `pty-manager.ts`, project scoping, venv activation, env scrubbing, idle reap, SIGTERM/SIGKILL cleanup, and tests. |
| WS auth and reattach | Partial | `@wterm/core` includes `WebSocketTransport`, but pi-forge's protocol is not a plain PTY pipe: client input and resize are JSON frames, auth token is in query string, and `tabId` controls server reattach/output replay. We would likely keep pi-forge's custom WebSocket code rather than use `WebSocketTransport` directly. |
| Resize | Good but needs integration | `wterm` supports `autoResize` and `onResize`; pi-forge would need to ensure resize messages remain JSON `{ type: "resize", cols, rows }` and continue to send the initial cached size on reconnect. |
| Scrollback | Partial | `wterm` advertises configurable scrollback and exposes scrollback APIs. Unknown until spiked: preserving scrollback across React remounts and project/tab visibility changes as reliably as current module-level xterm instances. |
| xterm.js feature parity | Risky | `xterm.js` describes itself as fully-featured, used by VS Code/Tabby/Hyper, and supports common apps such as bash, vim, tmux, curses apps, mouse events, performance features, and rich Unicode. Source: [xterm.js README](https://github.com/xtermjs/xterm.js/blob/master/README.md). `wterm`'s own core docs say the default lightweight core is not the full-featured path for Kitty protocols, proper grapheme handling, mouse tracking, etc.; those require optional `@wterm/ghostty` (~400 KB). Source: [`@wterm/core` README](https://github.com/vercel-labs/wterm/blob/main/packages/%40wterm/core/README.md). |
| Web links | Gap | pi-forge currently loads `@xterm/addon-web-links`, whose purpose is clickable web links. Source: [`@xterm/addon-web-links`](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links). I did not find an equivalent first-party wterm linkifier/addon API in the wterm READMEs. |
| Accessibility | Potential win | wterm's DOM renderer explicitly targets native text selection, clipboard, browser find, and screen-reader support. This is wterm's strongest reason to revisit later. |
| Mobile | Mixed | DOM selection/browser find may help mobile, but shell usability still depends on keyboard handling, modifier keys, paste, viewport resize, and safe scroll behavior. wterm has had recent fixes around paste, focus scroll, selection, Shift, Ctrl+A/E/U, and arrows, indicating active work but also product youth. Source: [wterm releases](https://github.com/vercel-labs/wterm/releases). |
| Packaging/build | Manageable | Client-only dependency change. `@wterm/dom` embeds WASM by default, avoiding a static asset copy; optional `wasmUrl` can serve it separately. Source: [`@wterm/dom` README](https://github.com/vercel-labs/wterm/blob/main/packages/%40wterm/dom/README.md). No server dependency change unless protocol is redesigned. |
| Maintenance risk | High today | wterm is young: npm package history began in April 2026. Releases include important early fixes such as npm publish fixes, background rendering, bracketed paste security, Zig version, paste handling, focus scroll, keybindings, and height/layout fixes. Source: [wterm releases](https://github.com/vercel-labs/wterm/releases). xterm.js is older, larger, and widely deployed; its README cites VS Code, Tabby, and Hyper usage. |

## Migration effort

A real migration is medium-to-high effort even though no server rewrite is needed.

Likely client work:

1. Replace `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-web-links` in `TerminalPanel.tsx` with `@wterm/dom` or `@wterm/react`.
2. Rebuild the imperative `live` resource map around `WTerm` instances, including remount, focus, theme update, reconnect timers, and teardown semantics.
3. Adapt `onData` so keyboard input still sends pi-forge JSON `{ type: "input", data }` frames rather than raw WebSocket bytes.
4. Adapt `onResize` so resize still sends `{ type: "resize", cols, rows }` and stores the last sent size for reconnect.
5. Confirm binary PTY output frames (`ArrayBuffer`/`Uint8Array`) flow into `WTerm.write` without decoding regressions.
6. Replace the web-link feature or accept losing clickable URLs.
7. Re-test panel toggle, tab switching, project switching, page reload, reconnect backoff, expired auth close handling, same-tab displacement, and idle reap.
8. Add manual compatibility passes for `vim`, `less`, `tmux`, `htop`, wide Unicode, emoji/graphemes, mouse apps, bracketed paste, large output, mobile keyboard/paste, browser zoom, and screen readers.

Possible server work only if choosing to use `wterm`'s `WebSocketTransport` directly:

- Change the WebSocket protocol from JSON input/resize frames to raw PTY frames plus an out-of-band resize/auth/control mechanism, or wrap `WebSocketTransport` to preserve pi-forge's protocol. That path is not recommended because it risks stable, tested behavior in `tests/test-terminal.ts` and `tests/test-pty-reattach.ts`.

## Suggested revisit criteria

Consider a feature-flagged spike later if most of these become true:

- wterm has several months of production use and release stability.
- A first-party or documented linkifier story exists, or clickable links are deemed nonessential.
- The default core handles pi-forge's target apps well, or the bundle cost of `@wterm/ghostty` is acceptable.
- A spike passes the existing terminal tests plus manual `vim`/`tmux`/mouse/Unicode/mobile/screen-reader checks.
- The migration can preserve current reattach/output-replay behavior without server protocol churn.

## Conclusion

`wterm` is attractive as an accessibility- and DOM-selection-focused terminal renderer, but it is not a drop-in replacement for pi-forge's integrated terminal stack. The production risk and migration cost outweigh the benefits today. Keep `xterm.js` for now; track `wterm` and revisit with a contained spike if accessibility/browser-find becomes a top terminal priority.
