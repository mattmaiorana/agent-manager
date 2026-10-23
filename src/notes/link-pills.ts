// Live Preview's marking of the plugin's links.

import { import_cm_view } from "../externals.js";
import type { Extension, Range } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
// Live Preview draws a markdown link without its URL, so CSS can't tell a session's
// link from any other link. This marks the label of each one (a
// `[label](obsidian://agent-manager?...)` link, to resume or start a session) with a
// class, and styles.css
// draws it as a pill. Visible lines only, and only the matched link, so another link on
// the same line keeps its own look.
const SESSION_LINK_RE = /\[([^\]\n]+)\]\(obsidian:\/\/agent-manager\?[^)\s]*op=(?:resume|new)[^)\s]*\)/g;
function sessionLinkLabels(): Extension {
  const { ViewPlugin, Decoration } = import_cm_view;
  const mark = Decoration.mark({ class: "agent-manager-session-link" });
  // The line holding one, so CSS can hide Obsidian's external-link arrow there without :has().
  const lineMark = Decoration.line({ class: "agent-manager-session-link-line" });
  const build = (view: EditorView): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    // A line can span two visible ranges (a widget folded in it), so each is read once.
    let lastLine = 0;
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        pos = line.to + 1;
        if (line.number <= lastLine) continue;
        lastLine = line.number;
        if (line.text.includes("obsidian://agent-manager?")) {
          let marked = false;
          for (const m of line.text.matchAll(SESSION_LINK_RE)) {
            if (!marked) { ranges.push(lineMark.range(line.from)); marked = true; }
            const start = line.from + m.index + 1;
            ranges.push(mark.range(start, start + m[1].length));
          }
        }
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(class {
    declare decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate): void { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: (v) => v.decorations });
}
export { sessionLinkLabels };
