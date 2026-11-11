
import { import_cm_view } from "../externals.js";
import type { Extension, Range } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
const SESSION_LINK_RE = /\[([^\]\n]+)\]\(obsidian:\/\/agent-manager\?[^)\s]*op=(?:resume|new)[^)\s]*\)/g;
function sessionLinkLabels(): Extension {
  const { ViewPlugin, Decoration } = import_cm_view;
  const mark = Decoration.mark({ class: "agent-manager-session-link" });
  const lineMark = Decoration.line({ class: "agent-manager-session-link-line" });
  const build = (view: EditorView): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
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
