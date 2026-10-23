// The parts of CodeMirror 6 the plugin uses (notes/link-pills.ts), with the types its
// packages publish. The packages aren't installed: Obsidian supplies @codemirror/view at
// run time (the build leaves it external), and `legacy-peer-deps` (.npmrc) keeps npm from
// installing them as the obsidian package's peers. Obsidian's own types read Extension
// from here too, for registerEditorExtension. Types only.

declare module "@codemirror/state" {
  // Anything an editor can be configured with: an extension, or a list of them.
  export type Extension = { extension: Extension } | readonly Extension[];
  // A range of the document a value covers, as RangeValue.range makes one.
  export class Range<T> {
    readonly from: number;
    readonly to: number;
    readonly value: T;
  }
  // A sorted set of ranges.
  export class RangeSet<T> {
    readonly size: number;
    between(from: number, to: number, f: (from: number, to: number, value: T) => void | false): void;
  }
  // One line of the document.
  export interface Line {
    readonly from: number;
    readonly to: number;
    readonly number: number;
    readonly text: string;
  }
  // The document.
  export interface Text {
    lineAt(pos: number): Line;
  }
  export interface EditorState {
    readonly doc: Text;
  }
}

declare module "@codemirror/view" {
  import type { EditorState, Extension, Range, RangeSet } from "@codemirror/state";

  // A mark or a line decoration, and the set a view plugin gives the editor.
  export abstract class Decoration {
    static mark(spec: { class?: string }): Decoration;
    static line(spec: { class?: string }): Decoration;
    static set(of: Range<Decoration> | readonly Range<Decoration>[], sort?: boolean): DecorationSet;
    range(from: number, to?: number): Range<Decoration>;
  }
  export type DecorationSet = RangeSet<Decoration>;
  export class EditorView {
    readonly state: EditorState;
    readonly visibleRanges: readonly { from: number; to: number }[];
  }
  // What changed, as a view plugin's update is told.
  export class ViewUpdate {
    readonly view: EditorView;
    readonly docChanged: boolean;
    readonly viewportChanged: boolean;
  }
  export interface PluginValue {
    update?(update: ViewUpdate): void;
    destroy?(): void;
  }
  export interface PluginSpec<V extends PluginValue> {
    decorations?: (value: V) => DecorationSet;
  }
  // CodeMirror's is generic in the plugin's value, which nothing here reads.
  export class ViewPlugin {
    readonly extension: Extension;
    static fromClass<V extends PluginValue>(cls: new (view: EditorView) => V, spec?: PluginSpec<V>): ViewPlugin;
  }
}
