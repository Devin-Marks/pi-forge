/**
 * CodeMirror 6 extension that paints a VS Code-style git-diff gutter
 * + scrollbar overview alongside the editor.
 *
 *   - Gutter: a 3px-wide colored bar in the left margin per changed
 *     line. Green = added, blue = modified, red triangle = deletion
 *     marker on the line below the deletion.
 *   - Scrollbar overview: an absolutely-positioned overlay on the
 *     right edge of the scroller with proportional marker dots so
 *     the user can see at a glance where in a long file the changes
 *     are. CM6 doesn't natively support scrollbar markers (Monaco
 *     does); this is the canonical workaround — render an overlay
 *     positioned by `(line / totalLines) * 100%`.
 *
 * Diff data flows in via `setDiffEffect(...)` dispatched on the view.
 * A StateField holds the current `DiffLine[]` so swaps don't require
 * rebuilding EditorState (cursor / undo / scroll all preserved).
 *
 * Why not @codemirror/merge: that's the side-by-side diff package,
 * intended for explicitly comparing two documents. We want gutter
 * decorations on a single editor reflecting the working-tree-vs-HEAD
 * diff — closer to a custom decoration set than a merge view.
 */
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate, gutter } from "@codemirror/view";
import type { DiffLine, DiffLineKind } from "../lib/diff-parser";

/**
 * Update the diff data on the editor. Dispatched via
 * `view.dispatch({ effects: setDiffEffect(changes) })`.
 *
 * Pass `[]` to clear all decorations (e.g. when switching to a file
 * not in a git repo, or when the working tree matches HEAD).
 */
export const setDiffEffect = StateEffect.define<DiffLine[]>();

const diffField = StateField.define<DiffLine[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setDiffEffect)) return e.value;
    }
    return value;
  },
});

class DiffMarker extends GutterMarker {
  constructor(public readonly kind: DiffLineKind) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof DiffMarker && other.kind === this.kind;
  }
  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = `cm-diff-marker cm-diff-marker-${this.kind}`;
    return div;
  }
}

const ADDED_MARKER = new DiffMarker("added");
const MODIFIED_MARKER = new DiffMarker("modified");
const DELETED_MARKER = new DiffMarker("deletedAbove");

function markerFor(kind: DiffLineKind): DiffMarker {
  if (kind === "added") return ADDED_MARKER;
  if (kind === "modified") return MODIFIED_MARKER;
  return DELETED_MARKER;
}

const diffGutter = gutter({
  class: "cm-diff-gutter",
  lineMarker: (view, blockInfo) => {
    const lineNo = view.state.doc.lineAt(blockInfo.from).number;
    const changes = view.state.field(diffField, false);
    if (changes === undefined || changes.length === 0) return null;
    // Linear scan is fine — typical diffs are tens of entries, called
    // once per visible line. Optimization (binary search, indexed
    // map) is a micro-win not worth the complexity here.
    for (const c of changes) {
      if (c.line === lineNo) return markerFor(c.kind);
    }
    return null;
  },
  // Reserve column width so the gutter doesn't visually shift in/out
  // when the diff first lands. Width is set via CSS in the theme below.
  initialSpacer: () => ADDED_MARKER,
});

/**
 * Right-edge overlay rendering proportional markers for every
 * changed line. Sits ON TOP of the native scrollbar (with
 * pointer-events: none so clicks still scroll). Updates on every
 * doc change AND every diffField update (dispatched via setDiffEffect).
 */
const diffOverview = ViewPlugin.fromClass(
  class {
    private readonly dom: HTMLDivElement;
    constructor(private readonly view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-diff-overview";
      // Append to the editor's outer DOM (not the scroller) so the
      // overlay isn't itself scrolled. Position is absolute relative
      // to the editor; theme below pins it to the right edge.
      view.dom.appendChild(this.dom);
      this.render();
    }
    update(u: ViewUpdate): void {
      const diffChanged = u.transactions.some((t) => t.effects.some((e) => e.is(setDiffEffect)));
      if (!u.docChanged && !diffChanged && !u.viewportChanged) return;
      this.render();
    }
    destroy(): void {
      this.dom.remove();
    }
    private render(): void {
      const changes = this.view.state.field(diffField, false);
      // Always replace contents; the input is small (tens of entries
      // typically) so a full rebuild beats per-marker diffing.
      this.dom.replaceChildren();
      if (changes === undefined || changes.length === 0) return;
      const totalLines = Math.max(this.view.state.doc.lines, 1);
      for (const c of changes) {
        const m = document.createElement("div");
        m.className = `cm-diff-overview-marker cm-diff-overview-${c.kind}`;
        // Clamp to [0, 100]; deletion-at-EOF can produce line ===
        // totalLines + 1 because the deleted lines aren't in the
        // current file's line count.
        const pct = Math.min(100, (c.line / totalLines) * 100);
        m.style.top = `${pct}%`;
        this.dom.appendChild(m);
      }
    }
  },
);

const diffTheme = EditorView.theme({
  ".cm-diff-gutter": {
    width: "3px",
    padding: "0",
    background: "transparent",
  },
  ".cm-diff-marker": {
    width: "3px",
    height: "100%",
    boxSizing: "border-box",
  },
  // VS Code's exact gutter colors (dark theme): subdued enough to
  // not compete with syntax highlighting but still legible against
  // the editor background.
  ".cm-diff-marker-added": {
    background: "#487e02",
  },
  ".cm-diff-marker-modified": {
    background: "#1b81a8",
  },
  // Deletion-above renders as a triangle pointing right at the line
  // junction, mirroring VS Code's affordance. CSS triangle trick:
  // zero-width box with a colored left border.
  ".cm-diff-marker-deletedAbove": {
    width: "0",
    height: "0",
    background: "transparent",
    borderLeft: "4px solid #f14c4c",
    borderTop: "3px solid transparent",
    borderBottom: "3px solid transparent",
    marginTop: "-3px",
  },
  // Scrollbar overview overlay — fixed to the right edge of the
  // editor. Width matches a typical Mac overlay scrollbar (~8px) so
  // markers sit just inside it. pointer-events: none so the user can
  // still drag the underlying scrollbar.
  ".cm-diff-overview": {
    position: "absolute",
    top: "0",
    bottom: "0",
    right: "0",
    width: "8px",
    pointerEvents: "none",
    zIndex: "2",
  },
  ".cm-diff-overview-marker": {
    position: "absolute",
    right: "1px",
    width: "6px",
    height: "3px",
    borderRadius: "1px",
    transform: "translateY(-1px)",
  },
  ".cm-diff-overview-added": { background: "#487e02" },
  ".cm-diff-overview-modified": { background: "#1b81a8" },
  ".cm-diff-overview-deletedAbove": { background: "#f14c4c" },
});

/**
 * Aggregate extension. Add to the editor's extension list once at
 * construction; dispatch `setDiffEffect(changes)` when diff data
 * arrives or changes.
 */
export function gitDiffExtension(): Extension {
  return [diffField, diffGutter, diffOverview, diffTheme];
}
