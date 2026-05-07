import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { themeDef, useThemeStore } from "../lib/theme";
import type { DiffLine } from "../lib/diff-parser";
import { gitDiffExtension, setDiffEffect } from "./codemirror-diff-extension";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
// Legacy modes — CM5-era language definitions wrapped via
// `StreamLanguage.define()` for CM6. Quality is generally lower than
// the first-party Lezer parsers above (no incremental parsing, no
// nested-language support), but the coverage is wide and the bundle
// cost per language is small (~1–3 KB minified each). Sub-path
// imports keep tree-shaking honest — the bundler only pulls in the
// modes we actually reference.
import { jinja2 } from "@codemirror/legacy-modes/mode/jinja2";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { r } from "@codemirror/legacy-modes/mode/r";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { go } from "@codemirror/legacy-modes/mode/go";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { kotlin, scala, csharp } from "@codemirror/legacy-modes/mode/clike";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { xml } from "@codemirror/legacy-modes/mode/xml";
// `sql` here is the legacy-modes factory; `standardSQL` is the
// pre-baked StreamParser for ANSI SQL, which is what we want.
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import type { OpenFile } from "../store/file-store";

/**
 * CodeMirror host. Lives in its own module so EditorPanel can pull it
 * in via `React.lazy()` — the CM bundle is ~700 KB minified and the
 * user might never open a file in a given session, so it shouldn't
 * weigh down the initial app load.
 *
 * Keyed on the tab's stable `tabId` (assigned at open time) — switching
 * tabs unmounts + remounts, but RENAMING the file keeps the same
 * tabId so cursor / scroll / undo / selection survive.
 */
export function CodeMirrorEditor({
  file,
  onChange,
  onSaveShortcut,
  wrap,
  diffChanges,
  onConsumePendingNav,
}: {
  file: OpenFile;
  onChange: (next: string) => void;
  onSaveShortcut: () => void;
  wrap: boolean;
  /**
   * Per-line diff decorations to render in the gutter + scrollbar
   * overview. Pass an empty array (or omit) when the file isn't in a
   * git repo, when the working tree matches HEAD, or while the diff
   * is being fetched. Updates are applied via `setDiffEffect` —
   * cursor / undo / scroll are preserved.
   */
  diffChanges?: DiffLine[];
  /**
   * Called after the editor scrolls to a `pendingNav` position so the
   * caller can clear the field and prevent re-scroll on subsequent
   * draft updates. Passes the path so the caller can match the
   * right tab when multiple are open.
   */
  onConsumePendingNav: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // CodeMirror Compartment for the lineWrapping extension. A
  // compartment lets us swap that one extension at runtime via
  // `dispatch({ effects: wrapCompartment.reconfigure(...) })` without
  // rebuilding the entire EditorState (which would lose cursor, undo,
  // selection, etc.).
  const wrapCompartmentRef = useRef<Compartment>(new Compartment());
  // Theme compartment lets us swap between oneDark and the
  // CodeMirror default light theme at runtime when the user picks a
  // different app theme — same trick as the wrap compartment, no
  // EditorState rebuild required.
  const themeCompartmentRef = useRef<Compartment>(new Compartment());
  const activeTheme = useThemeStore((s) => s.theme);
  const editorMode = themeDef(activeTheme).mode;

  // Latest `onChange` / `onSaveShortcut` in refs so the EditorView
  // listener doesn't capture stale closures across renders.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  const consumePendingNavRef = useRef(onConsumePendingNav);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSaveShortcut;
  }, [onSaveShortcut]);
  useEffect(() => {
    consumePendingNavRef.current = onConsumePendingNav;
  }, [onConsumePendingNav]);

  // Build the EditorView once per mount (per file, thanks to the React
  // `key`). Tearing down on unmount avoids the classic CodeMirror leak
  // where the DOM node gets reattached without the view's listeners
  // wired up.
  useEffect(() => {
    if (containerRef.current === null) return undefined;
    const langExt = languageExtension(file.language);
    const exts: Extension[] = [
      basicSetup,
      // Initial theme matches the user's currently-applied app
      // theme. Swapped at runtime via the compartment below; no
      // light-themed CodeMirror pack is bundled, so light mode
      // falls back to CodeMirror's default light styling (which
      // reads cleanly on white backgrounds).
      themeCompartmentRef.current.of(editorMode === "dark" ? oneDark : []),
      wrapCompartmentRef.current.of(wrap ? EditorView.lineWrapping : []),
      // Git diff gutter + scrollbar overview. The extension itself
      // doesn't need a compartment — the StateField it ships with
      // accepts diff updates via setDiffEffect dispatched below.
      gitDiffExtension(),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const value = update.state.doc.toString();
        onChangeRef.current(value);
      }),
    ];
    if (langExt !== undefined) exts.push(langExt);
    const state = EditorState.create({ doc: file.draft, extensions: exts });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    // Seed the initial diff if one was already known at mount (e.g.
    // tab restored from session storage with a cached diff). The
    // useEffect below handles subsequent updates.
    if (diffChanges !== undefined && diffChanges.length > 0) {
      view.dispatch({ effects: setDiffEffect.of(diffChanges) });
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure the wrap compartment when the prop changes. Unlike
  // a full editor rebuild, this preserves cursor / scroll / undo.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // Reconfigure the theme compartment when the user changes the
  // app theme. dark→light flips oneDark off; light→dark flips it
  // back on. Same compartment trick as wrap — preserves editor
  // state.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(editorMode === "dark" ? oneDark : []),
    });
  }, [editorMode]);

  // External draft change (e.g. reloadFile bringing fresh disk content)
  // — sync into the editor without firing onChange.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.doc.toString() === file.draft) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: file.draft },
    });
  }, [file.draft]);

  // Push diff updates into the StateField. Empty array clears markers
  // (file not in git, working tree matches HEAD, or fetch in flight).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: setDiffEffect.of(diffChanges ?? []) });
  }, [diffChanges]);

  // No autosave. Saves go through Cmd/Ctrl+S (handled by the editor's
  // keymap and routed via `onSaveShortcut`) or the explicit Save
  // button in EditorPanel's toolbar. The `dirty` flag on each tab
  // surfaces unsaved state in the tab strip so the user knows when a
  // save is needed.

  // Pending-navigation effect: when the file-store sets `pendingNav`
  // on this tab (e.g. from a search-result click), scroll the editor
  // to that line, place the cursor there, and clear the field via
  // `consumePendingNav` so it doesn't replay on the next render.
  // Wait for a tick so the doc is in place if pendingNav was set
  // alongside an `openFile` that just dispatched a doc replace.
  useEffect(() => {
    if (file.pendingNav === undefined) return;
    const nav = file.pendingNav;
    const view = viewRef.current;
    if (view === null) return;
    const id = window.setTimeout(() => {
      const lineNo = Math.max(1, Math.min(view.state.doc.lines, nav.line));
      const line = view.state.doc.line(lineNo);
      const col = Math.max(0, (nav.column ?? 1) - 1);
      const pos = Math.min(line.from + col, line.to);
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
      consumePendingNavRef.current(file.path);
    }, 0);
    return () => window.clearTimeout(id);
  }, [file.pendingNav, file.path]);

  return <div ref={containerRef} className="flex-1 overflow-auto" />;
}

function languageExtension(language: string): Extension | undefined {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "python":
      return python();
    case "rust":
      return rust();
    case "cpp":
    case "c":
      return cpp();
    case "java":
      return java();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "css":
    case "scss":
      return css();
    case "yaml":
      return yaml();
    // ----------------- legacy-modes-backed -----------------
    case "jinja2":
      return StreamLanguage.define(jinja2);
    case "shell":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
    case "properties":
      return StreamLanguage.define(properties);
    case "lua":
      return StreamLanguage.define(lua);
    case "perl":
      return StreamLanguage.define(perl);
    case "r":
      return StreamLanguage.define(r);
    case "powershell":
      return StreamLanguage.define(powerShell);
    case "ruby":
      return StreamLanguage.define(ruby);
    case "go":
      return StreamLanguage.define(go);
    case "swift":
      return StreamLanguage.define(swift);
    case "kotlin":
      return StreamLanguage.define(kotlin);
    case "scala":
      return StreamLanguage.define(scala);
    case "groovy":
      return StreamLanguage.define(groovy);
    case "csharp":
      return StreamLanguage.define(csharp);
    case "xml":
      return StreamLanguage.define(xml);
    case "sql":
      return StreamLanguage.define(standardSQL);
    case "diff":
      return StreamLanguage.define(diff);
    case "clojure":
      return StreamLanguage.define(clojure);
    case "haskell":
      return StreamLanguage.define(haskell);
    case "ocaml":
      return StreamLanguage.define(oCaml);
    case "protobuf":
      return StreamLanguage.define(protobuf);
    case "cmake":
      return StreamLanguage.define(cmake);
    case "nginx":
      return StreamLanguage.define(nginx);
    // Note: `legacy-modes` ships no makefile mode; the server detects
    // Makefile/.mk files but falls through to plaintext here. Use
    // shell as a passable fallback so tabs/comments at least colour
    // sensibly. (Could swap to a dedicated Lezer makefile parser
    // later if it surfaces as a real annoyance.)
    case "makefile":
      return StreamLanguage.define(shell);
    default:
      return undefined;
  }
}
