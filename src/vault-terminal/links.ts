// Finding web addresses and file paths in a line of terminal output, for
// Cmd+click. Kept free of xterm and Obsidian so test/harness.ts can check it
// from plain Node.

export interface FoundLink {
  /** Index into the text, inclusive. */
  start: number;
  /** Index into the text, exclusive. */
  end: number;
  url: string;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?]+$/;

/** Web addresses in text, without the punctuation a sentence puts after them. */
export function findUrls(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // Closing brackets belong to the address only when it opened them too:
    // (see https://x.org/a_(b)) keeps "(b)" and drops the last ")".
    for (;;) {
      const before = url;
      url = url.replace(TRAILING, "");
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        if (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
      }
      if (url === before) break;
    }
    if (/^https?:\/\/[^/]/.test(url)) found.push({ start: m.index, end: m.index + url.length, url });
  }
  return found;
}

/** Every ")" closes a "(" before it, and none is left open. */
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
  /** As written: absolute, ~/, or relative. */
  path: string;
}

// Words that could be a path: no spaces, quotes, or brackets other than
// parentheses, which file names can contain ("report (final).md"). An
// apostrophe between two letters or digits is part of a name ("Sam's
// notes.md"); anywhere else it's a quote, as in open('a.md') or x='a.md'.
// Curly quotes count the same way. Known misses, left as rare: a quote right
// after a letter, as in Python's f'a.md', and a.md'b.md, read as one name.
const WORD_RE = /(?:[^\s"'`‘’“”<>[\]{}|]|(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}]))+/gu;
// Where a run of words can't be joined: a quote, a bracket, or a tab.
const NO_JOIN = /["`‘“”<>[\]{}|\t]|(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/u;
// A path that runs on past a space: at most this many more words. A note's vault
// path in nested folders runs to a dozen.
const MAX_SPACES = 24;

/**
 * Sentence punctuation, a trailing line number (a.ts:12, a.ts:12:5), and
 * parentheses that only wrap the path (see (a.md)) aren't part of it.
 */
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
    // Parentheses around the whole path, (README.md), leaving any of its own: (report(final).md).
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
    // A bare file name with an extension, spaces and any script allowed: "Daily note.md".
    /^[^\s/.][^/]*\.[\p{L}\p{N}]{1,10}$/u.test(path)
  );
}

/**
 * File paths in text that exist: absolute (/, ~/), relative with a slash
 * (./a, ../a, src/a.ts), or a bare name with an extension (a.md), as
 * `exists` judges them. A path may contain spaces (a vault called "Dev
 * Vault", a note called "Daily note.md"): the earliest start and then the
 * longest run of words that exists wins, so "Daily note.md" never links as
 * just "note.md". Web addresses aren't paths.
 */
export function findPaths(text: string, exists: (path: string) => boolean): FoundPath[] {
  const found: FoundPath[] = [];
  // Each candidate is checked once: trimming makes different runs the same path.
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
    // Longest first: this word and up to MAX_SPACES more, joined by the text between them.
    let best: FoundPath | null = null;
    for (let j = Math.min(words.length - 1, i + MAX_SPACES); j >= i && !best; j--) {
      const run = text.slice(w.start, words[j].end);
      // Joined only across spaces, never across quotes, brackets or tabs.
      if (NO_JOIN.test(run)) continue;
      const { path, lead } = trimPath(run);
      // A possessive after a path (README.md's) isn't part of it, unless a
      // file by the whole name exists.
      for (const p of /['’]s$/i.test(path) ? [path, path.slice(0, -2)] : [path]) {
        if (p && p !== "/" && looksLikePath(p) && has(p)) {
          best = { start: w.start + lead, end: w.start + lead + p.length, path: p };
          break;
        }
      }
    }
    if (!best) continue;
    found.push(best);
    // Skip the words the path took in.
    while (i + 1 < words.length && words[i + 1].start < best.end) i++;
  }
  return found;
}
