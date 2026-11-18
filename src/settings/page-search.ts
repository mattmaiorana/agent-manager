
import type { SettingDefinition } from "obsidian";

type Node = { name?: unknown; desc?: unknown; aliases?: unknown; items?: unknown; visible?: unknown };

const text = (v: unknown): string =>
  typeof v === "string" ? v : v instanceof DocumentFragment ? v.textContent ?? "" : "";

const shown = (node: Node): boolean => {
  const v = node.visible;
  if (typeof v === "function") { try { return (v as () => boolean)() !== false; } catch { return true; } }
  return v !== false;
};

function matches(node: Node, query: string): boolean {
  if (!shown(node)) return false;
  const words = [text(node.name), text(node.desc), ...(Array.isArray(node.aliases) ? node.aliases.map(text) : [])];
  if (words.some((w) => w.toLowerCase().includes(query))) return true;
  return Array.isArray(node.items) && (node.items as Node[]).some((child) => matches(child, query));
}

export const pageSearch = {
  placeholder: "Find a setting…",
  match: (def: SettingDefinition, query: string): boolean => {
    const q = query.trim().toLowerCase();
    return !q || matches(def, q);
  },
};
