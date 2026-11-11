
declare module "@codemirror/state" {
  export type Extension = { extension: Extension } | readonly Extension[];
  export class Range<T> {
    readonly from: number;
    readonly to: number;
    readonly value: T;
  }
  export class RangeSet<T> {
    readonly size: number;
    between(from: number, to: number, f: (from: number, to: number, value: T) => void | false): void;
  }
  export interface Line {
    readonly from: number;
    readonly to: number;
    readonly number: number;
    readonly text: string;
  }
  export interface Text {
    lineAt(pos: number): Line;
  }
  export interface EditorState {
    readonly doc: Text;
  }
}

declare module "@codemirror/view" {
  import type { EditorState, Extension, Range, RangeSet } from "@codemirror/state";

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
  export class ViewPlugin {
    readonly extension: Extension;
    static fromClass<V extends PluginValue>(cls: new (view: EditorView) => V, spec?: PluginSpec<V>): ViewPlugin;
  }
}
