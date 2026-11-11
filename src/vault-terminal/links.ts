
export interface FoundLink {
  start: number;
  end: number;
  url: string;
}

const URL_RE = /\b(?:https?|obsidian):\/\/(?:[^\s<>"'`─-╿—]|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}%]))+/gu;
const TRAILING = /[.,;:!?*…]+$/;
const OBSIDIAN_LINK = /^obsidian:\/\/(?:open\/?\?(?=(?:\S*&)?(?:file|path)=)|agent-manager\/?\?\S|vault\/[^\s/])/;

export function findUrls(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    for (;;) {
      const before = url;
      url = url.replace(TRAILING, "");
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        if (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
      }
      if (url === before) break;
    }
    if (/^https?:\/\/[^/]/.test(url) || OBSIDIAN_LINK.test(url)) found.push({ start: m.index, end: m.index + url.length, url });
  }
  return found;
}

export function findUrlsAcross(text: string, edges: ReadonlySet<number>, keepShort: (longer: string, shorter: string) => boolean): FoundLink[] {
  const out: FoundLink[] = [];
  for (const found of findUrls(text)) {
    const last = out[out.length - 1];
    if (last && found.start < last.end) continue;
    const { start } = found;
    let { end, url } = found;
    const skipped: number[] = [];
    while (edges.has(end) && !/^(?:https?|obsidian):\/\//.test(text.slice(end + 1))) {
      skipped.push(end);
      let joined = "";
      let from = start;
      for (const k of skipped) {
        joined += text.slice(from, k);
        from = k + 1;
      }
      joined += text.slice(from);
      const longer = findUrls(joined)[0];
      const had = end - start - (skipped.length - 1);
      if (longer?.start !== 0 || longer.end <= had || keepShort(longer.url, url)) {
        skipped.pop();
        break;
      }
      url = longer.url;
      end = start + longer.end + skipped.length;
    }
    out.push({ start, end, url });
  }
  return out;
}

export function linksObsidian(uri: string): boolean {
  return OBSIDIAN_LINK.test(uri);
}

export interface ObsidianLink {
  action: string;
  params: Record<string, string>;
}

export function parseObsidianLink(uri: string): ObsidianLink | null {
  if (!OBSIDIAN_LINK.test(uri)) return null;
  const rest = uri.slice("obsidian://".length);
  try {
    if (rest.startsWith("vault/")) {
      const parts = rest.slice(6).split("/").map(decodeURIComponent);
      return { action: "open", params: { action: "open", vault: parts[0], file: parts.slice(1).join("/") } };
    }
    const q = rest.indexOf("?");
    const action = rest.slice(0, q).replace(/\/$/, "");
    const params: Record<string, string> = {};
    for (const pair of rest.slice(q + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      if (Object.hasOwn(params, key)) return null;
      params[key] = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
    }
    params.action = action;
    return { action, params };
  } catch {
    return null;
  }
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

export interface FoundPath {
  start: number;
  end: number;
  path: string;
}

const WORD_RE = /(?:[^\s"'`‘’“”<>[\]{}|]|(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}]))+/gu;
const NO_JOIN = /["`‘“”<>[\]{}|\t]|(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/u;
const MAX_SPACES = 24;

function trimPath(word: string): { path: string; lead: number } {
  let path = word;
  let lead = 0;
  for (;;) {
    const before = path;
    path = path.replace(TRAILING, "").replace(/:\d+(:\d+)?$/, "");
    if (path.endsWith(")") && count(path, ")") > count(path, "(")) path = path.slice(0, -1);
    if (path.startsWith("(") && count(path, "(") > count(path, ")")) {
      path = path.slice(1);
      lead++;
    }
    if (path.startsWith("(") && path.endsWith(")") && balanced(path.slice(1, -1))) {
      path = path.slice(1, -1);
      lead++;
    }
    if (path === before) return { path, lead };
  }
}

function looksLikePath(path: string): boolean {
  return (
    /^(~|\.{1,2})?\//.test(path) ||
    /[^/]\/[^/]/.test(path) ||
    /^[^\s/.][^/]*\.[\p{L}\p{N}]{1,10}$/u.test(path)
  );
}

const WRAP_SLACK = 8;
const BOX = /^[\u2500-\u257f]|[\u2500-\u257f]$/;
const NEW_BLOCK = /^[⏺⎿]/u;

export interface RowCells {
  text: string;
  columns: number[];
}

const LEAD = /^\s*(?:[-*•⏺]|\d+[.)])?\s*/u;

export function cliWrapped(prev: RowCells, next: RowCells, cols: number): boolean {
  const end = prev.text.trimEnd().length;
  const start = next.text.length - next.text.trimStart().length;
  if (!end || start === next.text.length) return false;
  if (BOX.test(prev.text.slice(0, end)) || BOX.test(next.text.slice(start)) || NEW_BLOCK.test(next.text.slice(start))) return false;
  const lead = LEAD.exec(prev.text)?.[0].length ?? 0;
  const cellAt = (row: RowCells, i: number): number => row.columns[i] ?? i;
  if (cellAt(next, start) > cellAt(prev, Math.min(lead, end))) return false;
  const gap = next.text.slice(start).search(/\s/);
  const wordEnd = gap === -1 ? next.text.length : start + gap;
  const used = cellAt(prev, end - 1) + 1;
  const word = cellAt(next, wordEnd - 1) - cellAt(next, start) + 1;
  return used + 1 + word > cols - WRAP_SLACK;
}

export function pathsEnding(paths: Iterable<string>, partial: string): string[] {
  const want = partial.toLowerCase();
  if (!want || want.startsWith("/")) return [];
  const found: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower === want || lower.endsWith(`/${want}`)) found.push(p);
  }
  return found;
}

export function findPaths(text: string, exists: (path: string) => boolean): FoundPath[] {
  const found: FoundPath[] = [];
  const checked = new Map<string, boolean>();
  const has = (path: string): boolean => {
    let yes = checked.get(path);
    if (yes === undefined) checked.set(path, (yes = exists(path)));
    return yes;
  };
  const words = [...text.matchAll(WORD_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.text.includes("://")) continue;
    let best: FoundPath | null = null;
    for (let j = Math.min(words.length - 1, i + MAX_SPACES); j >= i && !best; j--) {
      const run = text.slice(w.start, words[j].end);
      if (NO_JOIN.test(run)) continue;
      const { path, lead } = trimPath(run);
      for (const p of /['’]s$/i.test(path) ? [path, path.slice(0, -2)] : [path]) {
        if (p && p !== "/" && looksLikePath(p) && has(p)) {
          best = { start: w.start + lead, end: w.start + lead + p.length, path: p };
          break;
        }
      }
    }
    if (!best) continue;
    found.push(best);
    while (i + 1 < words.length && words[i + 1].start < best.end) i++;
  }
  return found;
}

export interface LinkPiece {
  text: string;
  link: boolean;
}

export function linkPieces(texts: readonly string[], columns: readonly number[], links: readonly (readonly [number, number])[]): LinkPiece[][] | null {
  const inLink = (x: number): boolean => links.some(([a, b]) => x >= a && x <= b);
  const out: LinkPiece[][] = [];
  let at = 0;
  for (const text of texts) {
    if (at + text.length > columns.length) return null;
    const pieces: LinkPiece[] = [];
    for (let i = 0; i < text.length; i++) {
      const link = inLink(columns[at + i]);
      const last = pieces[pieces.length - 1];
      if (last?.link === link) last.text += text[i];
      else pieces.push({ text: text[i], link });
    }
    out.push(pieces);
    at += text.length;
  }
  return out;
}

