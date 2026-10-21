// Kitty's graphics protocol, the part the terminal draws: catching its sequences in a program's output before xterm.js sees
// them, reading what each says, keeping each terminal's pictures, and
// answering. No Obsidian or xterm code here, so test/harness.ts can drive it
// from plain Node. Drawing is pictures.ts.
//
// Protocol: https://sw.kovidgoyal.net/kitty/graphics-protocol/.
// What claude was seen to send: a=T,U=1 with c and r, from
// a PNG file (t=f), PNG bytes, or RGBA in 4,096-byte chunks; a=d,d=I to
// remove; placeholders with the image id in a true-color foreground and both
// row and column marks.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, normalize } from "path";
import { inflateSync } from "zlib";

/** The character a picture's cells hold. */
export const PLACEHOLDER = 0x10eeee;
export const PLACEHOLDER_TEXT = String.fromCodePoint(PLACEHOLDER);

// kitty's rowcolumn-diacritics.txt, in order: the nth is the number n.
const DIACRITIC_HEX =
  "0305,030D,030E,0310,0312,033D,033E,033F,0346,034A,034B,034C,0350,0351,0352,0357,035B,0363,0364,0365,0366,0367,0368,0369,036A,036B,036C,036D,036E,036F,0483,0484,0485,0486,0487,0592,0593,0594,0595,0597,0598,0599,059C,059D,059E,059F,05A0,05A1,05A8,05A9,05AB,05AC,05AF,05C4,0610,0611,0612,0613,0614,0615,0616,0617,0657,0658,0659,065A,065B,065D,065E,06D6,06D7,06D8,06D9,06DA,06DB,06DC,06DF,06E0,06E1,06E2,06E4,06E7,06E8,06EB,06EC,0730,0732,0733,0735,0736,073A,073D,073F,0740,0741,0743,0745,0747,0749,074A,07EB,07EC,07ED,07EE,07EF,07F0,07F1,07F3,0816,0817,0818,0819,081B,081C,081D,081E,081F,0820,0821,0822,0823,0825,0826,0827,0829,082A,082B,082C,082D,0951,0953,0954,0F82,0F83,0F86,0F87,135D,135E,135F,17DD,193A,1A17,1A75,1A76,1A77,1A78,1A79,1A7A,1A7B,1A7C,1B6B,1B6D,1B6E,1B6F,1B70,1B71,1B72,1B73,1CD0,1CD1,1CD2,1CDA,1CDB,1CE0,1DC0,1DC1,1DC3,1DC4,1DC5,1DC6,1DC7,1DC8,1DC9,1DCB,1DCC,1DD1,1DD2,1DD3,1DD4,1DD5,1DD6,1DD7,1DD8,1DD9,1DDA,1DDB,1DDC,1DDD,1DDE,1DDF,1DE0,1DE1,1DE2,1DE3,1DE4,1DE5,1DE6,1DFE,20D0,20D1,20D4,20D5,20D6,20D7,20DB,20DC,20E1,20E7,20E9,20F0,2CEF,2CF0,2CF1,2DE0,2DE1,2DE2,2DE3,2DE4,2DE5,2DE6,2DE7,2DE8,2DE9,2DEA,2DEB,2DEC,2DED,2DEE,2DEF,2DF0,2DF1,2DF2,2DF3,2DF4,2DF5,2DF6,2DF7,2DF8,2DF9,2DFA,2DFB,2DFC,2DFD,2DFE,2DFF,A66F,A67C,A67D,A6F0,A6F1,A8E0,A8E1,A8E2,A8E3,A8E4,A8E5,A8E6,A8E7,A8E8,A8E9,A8EA,A8EB,A8EC,A8ED,A8EE,A8EF,A8F0,A8F1,AAB0,AAB2,AAB3,AAB7,AAB8,AABE,AABF,AAC1,FE20,FE21,FE22,FE23,FE24,FE25,FE26,10A0F,10A38,1D185,1D186,1D187,1D188,1D189,1D1AA,1D1AB,1D1AC,1D1AD,1D242,1D243,1D244";
export const DIACRITICS = DIACRITIC_HEX.split(",").map((h) => parseInt(h, 16));
const DIACRITIC_VALUE = new Map(DIACRITICS.map((c, i) => [c, i]));

/** The number a row or column mark stands for, or undefined if it isn't one. */
export function diacriticValue(cp: number): number | undefined {
  return DIACRITIC_VALUE.get(cp);
}

/** Text with every placeholder and the marks that belong to it taken out; other marks stay. */
export function withoutPlaceholders(text: string): string {
  if (!text.includes(PLACEHOLDER_TEXT)) return text;
  let out = "";
  let inPlaceholder = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === PLACEHOLDER) {
      inPlaceholder = true;
      continue;
    }
    if (inPlaceholder && DIACRITIC_VALUE.has(cp)) continue;
    inPlaceholder = false;
    out += ch;
  }
  return out;
}

const u16 = (s: string) => Array.from({ length: s.length }, (_, k) => `\\u${s.charCodeAt(k).toString(16).padStart(4, "0")}`).join("");
// The table's marks as a regex alternative, in UTF-16 escapes: the search addon's regexes have no u flag.
const MARKS_PATTERN = DIACRITICS.map((cp) => u16(String.fromCodePoint(cp))).join("|");

/**
 * Find: a query holding one of the table's marks, as a regex that never
 * matches inside a picture's cells (right after a placeholder and its marks);
 * null for any other query, which can't match there anyway.
 */
export function findPattern(query: string): string | null {
  if (![...query].some((ch) => DIACRITIC_VALUE.has(ch.codePointAt(0)!))) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return `(?<!${u16(PLACEHOLDER_TEXT)}(?:${MARKS_PATTERN})*)${escaped}`;
}

/**
 * How often the picture code has run, for the self-test: with "Show
 * pictures" off, neither count moves.
 */
export const pictureCalls = { filter: 0, commands: 0 };

// --- limits ---

/**
 * One picture's pixels, width times height times four: claude's largest
 * (a 4,096-square raw file) fits. Checked from the keys or the PNG header
 * before anything is decoded.
 */
export const PICTURE_LIMIT = 64 * 1024 * 1024;
/**
 * Each terminal's pictures, stored data and decoded pixels together.
 * kitty's is 320 MB per screen buffer; this is per terminal, both buffers.
 */
export const STORE_CAP = 256 * 1024 * 1024;
/**
 * What a picture and each of its placements count against the cap beyond
 * their pixels, so many tiny ones can't grow memory under it. A picture keeps at most PLACEMENTS_KEPT placements, the
 * oldest going first.
 */
export const IMAGE_COST = 4096;
export const PLACEMENT_COST = 256;
export const PLACEMENTS_KEPT = 1024;
// An upload's chunks count this much each on top of their data, so empty ones can't pile up.
const CHUNK_COST = 64;

// --- catching the sequences ---

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;

export type Piece =
  | { kind: "text"; bytes: Uint8Array }
  | { kind: "graphics"; body: string }
  | { kind: "cancelled"; why: "CAN" | "SUB" | "ESC" | "size" };

/**
 * The OSC 8 link wrapped around a run of placeholder cells. xterm.js 6.0.0
 * keeps a cell's underline color (the placement id) only when the cell has
 * an underline style or a link (its ExtendedAttrs.isEmpty), and kitty's
 * placeholders carry the color with no style. A link of the terminal's own,
 * with a fixed id so xterm keeps one entry for it, makes xterm keep the
 * color, without changing xterm or drawing anything. The link does nothing
 * when clicked (openUri ignores its scheme), and the picture covers its cells.
 */
export const PICTURE_LINK = "vault-terminal:picture";
const LINK_OPEN = Buffer.from(`\x1b]8;id=vault-terminal-picture;${PICTURE_LINK}\x1b\\`, "latin1");
const LINK_CLOSE = Buffer.from("\x1b]8;;\x1b\\", "latin1");
// How much of an OSC is kept to see whether it's a link of the program's own.
const OSC_KEEP = 4096;

/**
 * Splits a program's output into what xterm.js should parse and the kitty
 * graphics commands it would drop. Keeps its place across chunks: a
 * sequence split between two reads is found whole. A command cut short by
 * CAN, SUB or another escape is dropped, as any unterminated control string
 * is; one past the size limit is dropped whole, its rest swallowed.
 */
export class GraphicsFilter {
  private carry: Uint8Array = new Uint8Array(0);
  private apc: Buffer[] | null = null;
  private apcSize = 0;
  private discarding = false;
  /** Inside some other control string (OSC, DCS, SOS, PM, another APC), whose bytes pass through. */
  private string: "osc" | "other" | null = null;
  private osc = "";
  /** The program has its own OSC 8 link open. */
  private programLink = false;
  /** The terminal's link around a placeholder run is open. */
  private linked = false;
  /** Set once pictures are turned off while a command was half-received: the rest is swallowed, nothing added. */
  draining = false;
  /** A placeholder has been seen: until then, nothing needs painting. */
  sawPlaceholder = false;

  constructor(readonly maxSequence = Math.ceil((PICTURE_LIMIT * 4) / 3) + 4096, private keepPlacementIds = true) {}

  /** Mid-command or holding bytes for the next chunk: switching the filter off now would print the rest. */
  get busy(): boolean {
    return this.apc !== null || this.carry.length > 0;
  }

  /** Closes the terminal's link if a placeholder run left it open, so later text isn't inside it; what xterm should read, if anything. */
  closeLink(): Uint8Array | null {
    if (!this.linked) return null;
    this.linked = false;
    return LINK_CLOSE;
  }

  push(chunk: Uint8Array): Piece[] {
    pictureCalls.filter++;
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = new Uint8Array(0);
    const pieces: Piece[] = [];
    let parts: Uint8Array[] = [];
    let run = 0;
    const n = data.length;
    const flushRun = (end: number) => {
      if (end > run) parts.push(data.subarray(run, end));
      run = end;
    };
    const flushText = () => {
      if (parts.length) pieces.push({ kind: "text", bytes: parts.length === 1 ? parts[0] : Buffer.concat(parts) });
      parts = [];
    };
    const hold = (from: number) => {
      flushRun(from);
      this.carry = Buffer.from(data.subarray(from));
      run = n;
    };
    let i = 0;
    outer: while (i < n) {
      const b = data[i];
      if (this.apc) {
        if (b === ESC) {
          if (i + 1 >= n) {
            hold(i);
            break;
          }
          if (data[i + 1] === 0x5c) {
            pieces.push(this.discarding ? { kind: "cancelled", why: "size" } : { kind: "graphics", body: Buffer.concat(this.apc).toString("latin1") });
            this.apc = null;
            i += 2;
            run = i;
            continue;
          }
          // Another escape starts: the command is cut short, and the escape is the program's.
          pieces.push({ kind: "cancelled", why: "ESC" });
          this.apc = null;
          run = i;
          continue;
        }
        if (b === CAN || b === SUB) {
          pieces.push({ kind: "cancelled", why: b === CAN ? "CAN" : "SUB" });
          this.apc = null;
          i++;
          run = i;
          continue;
        }
        let j = i;
        while (j < n && data[j] !== ESC && data[j] !== CAN && data[j] !== SUB) j++;
        if (!this.discarding) {
          this.apc.push(Buffer.from(data.subarray(i, j)));
          this.apcSize += j - i;
          if (this.apcSize > this.maxSequence) {
            this.discarding = true;
            this.apc = [];
          }
        }
        i = j;
        run = i;
        continue;
      }
      if (this.string) {
        // Passes through; only the end is looked for.
        if (b === BEL && this.string === "osc") {
          this.endString();
          i++;
          continue;
        }
        if (b === CAN || b === SUB) {
          this.string = null;
          i++;
          continue;
        }
        if (b === ESC) {
          if (i + 1 >= n) {
            hold(i);
            break;
          }
          if (data[i + 1] === 0x5c) {
            this.endString();
            i += 2;
            continue;
          }
          this.string = null;
          continue; // the escape starts something new
        }
        if (this.string === "osc" && this.osc.length < OSC_KEEP) this.osc += String.fromCharCode(b);
        i++;
        continue;
      }
      if (b === ESC) {
        if (this.linked) {
          flushRun(i);
          parts.push(LINK_CLOSE);
          this.linked = false;
        }
        if (i + 1 >= n) {
          hold(i);
          break;
        }
        const c = data[i + 1];
        if (c === 0x5f) {
          if (i + 2 >= n) {
            hold(i);
            break;
          }
          if (data[i + 2] === 0x47) {
            flushRun(i);
            flushText();
            this.apc = [];
            this.apcSize = 0;
            this.discarding = false;
            i += 3;
            run = i;
            continue;
          }
          this.string = "other";
          i += 2;
          continue;
        }
        if (c === 0x5d) {
          this.string = "osc";
          this.osc = "";
          i += 2;
          continue;
        }
        if (c === 0x50 || c === 0x58 || c === 0x5e) {
          this.string = "other";
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (b < 0x80) {
        if (this.linked) {
          flushRun(i);
          parts.push(LINK_CLOSE);
          this.linked = false;
        }
        i++;
        continue;
      }
      // A character beyond ASCII: is it a placeholder, or a mark of one?
      const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (len > 1 && i + len > n) {
        hold(i);
        break outer;
      }
      const cp = len === 4 ? ((b & 7) << 18) | ((data[i + 1] & 63) << 12) | ((data[i + 2] & 63) << 6) | (data[i + 3] & 63) : len === 3 ? ((b & 15) << 12) | ((data[i + 1] & 63) << 6) | (data[i + 2] & 63) : len === 2 ? ((b & 31) << 6) | (data[i + 1] & 63) : -1;
      if (cp === PLACEHOLDER) {
        this.sawPlaceholder = true;
        if (this.keepPlacementIds && !this.draining && !this.linked && !this.programLink) {
          flushRun(i);
          parts.push(LINK_OPEN);
          this.linked = true;
        }
      } else if (this.linked && !DIACRITIC_VALUE.has(cp)) {
        flushRun(i);
        parts.push(LINK_CLOSE);
        this.linked = false;
      }
      i += len;
    }
    if (run < n) flushRun(n);
    flushText();
    return pieces;
  }

  private endString(): void {
    if (this.string === "osc" && this.osc.startsWith("8;")) {
      const uri = this.osc.slice(this.osc.indexOf(";", 2) + 1);
      this.programLink = this.osc.indexOf(";", 2) > 0 && uri.length > 0;
    }
    this.string = null;
    this.osc = "";
  }
}

// --- commands ---

export interface Command {
  keys: Map<string, string>;
  payload: string;
}

export function parseCommand(body: string): Command {
  const semi = body.indexOf(";");
  const control = semi < 0 ? body : body.slice(0, semi);
  const keys = new Map<string, string>();
  for (const kv of control.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) keys.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return { keys, payload: semi < 0 ? "" : body.slice(semi + 1) };
}

function num(keys: Map<string, string>, k: string): number {
  const v = keys.get(k);
  if (v === undefined || !/^-?\d+$/.test(v)) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Base64, strictly (Node's own decoder never fails): null if it isn't. */
export function base64(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return null;
  return Buffer.from(text, "base64");
}

/** A PNG's width and height from its header, or null if it isn't a PNG. Nothing is decoded. */
export function pngSize(data: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || sig.some((v, k) => data[k] !== v)) return null;
  if (String.fromCharCode(data[12], data[13], data[14], data[15]) !== "IHDR") return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Pixel data's size, in bytes after inflating, for a PNG of this header: one filter byte per row, Adam7's passes for an interlaced one. */
function pngDataSize(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number {
  const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
  if (!interlaced) return height * rowBytes(width);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (w && h) total += h * rowBytes(w);
  }
  return total;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Whether a PNG would load (75, 76): its chunks are whole, through IEND,
 * and its pixel data inflates to at least what its header needs. The
 * header's size has already been checked against the limit, so inflating
 * is bounded. A truncated or corrupt PNG fails here, before any reply.
 */
export function pngLoads(data: Uint8Array, width: number, height: number): boolean {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ihdr = data.subarray(16, 29);
  if (data.length < 33 || dv.getUint32(8) !== 13) return false;
  const depth = ihdr[8];
  const color = ihdr[9];
  const channels = PNG_CHANNELS[color];
  // The header's own rules: the depths each color type allows, and the one
  // compression and filter method PNG has; interlace 0 or 1.
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!channels || !depths[color].includes(depth) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] > 1) return false;
  const idat: Uint8Array[] = [];
  let at = 8;
  let ended = false;
  while (at + 12 <= data.length) {
    const len = dv.getUint32(at);
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    if (at + 12 + len > data.length) return false;
    if (type === "IDAT") idat.push(data.subarray(at + 8, at + 8 + len));
    at += 12 + len;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || !idat.length) return false;
  const need = pngDataSize(width, height, channels * depth, ihdr[12] === 1);
  try {
    return inflateSync(Buffer.concat(idat), { maxOutputLength: need }).length >= need;
  } catch (e) {
    // More than the header needs is still a picture that loads.
    return (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
  }
}

// --- files ---

/** Every failure to read a picture file gets this one reply, as kitty's docs require. */
export const READ_ERROR = "EBADF:Failed to read image file";

// Never read, whatever the file: kitty's docs name these as sensitive.
const SENSITIVE = ["/dev", "/proc", "/sys", "/private/var/run"];

export interface FileRead {
  data: Uint8Array | null;
  /** Why it failed, for the log only; the program gets READ_ERROR. */
  why?: string;
}

/**
 * Reads a picture file a program named: only a regular file, with symlinks
 * followed and loops refused, checked on the path before anything opens it
 * (opening a pipe or a device can have side effects). size and offset are
 * kitty's S and O; a file shorter than claimed fails. opened is told every
 * path actually opened, for the self-test.
 */
export function readPictureFile(path: string, size: number, offset: number, limit: number, opened?: (p: string) => void): FileRead {
  if (!isAbsolute(path) || path.includes("\0")) return { data: null, why: "not an absolute path" };
  const sensitive = (p: string) => SENSITIVE.some((s) => p === s || p.startsWith(`${s}/`));
  if (sensitive(normalize(path))) return { data: null, why: "a sensitive folder" };
  // Where the symlinks lead, resolved once: the folder check, the type check
  // and the open all use it, so a link can't lead past the first or be
  // swapped between the second and the third (a loop fails here).
  let real: string;
  let st;
  try {
    real = realpathSync(path);
    if (sensitive(real)) return { data: null, why: "a sensitive folder" };
    st = statSync(real);
  } catch (e) {
    return { data: null, why: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
  if (!st.isFile()) return { data: null, why: "not a regular file" };
  const want = size > 0 ? size : st.size - offset;
  if (offset < 0 || want <= 0 || offset + want > st.size) return { data: null, why: `shorter than claimed (${st.size} bytes)` };
  if (want > limit) return { data: null, why: `over the size limit (${want} bytes)` };
  let fd = -1;
  try {
    opened?.(path);
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW);
    // The same file the check saw: not swapped for something else between the two.
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) return { data: null, why: "changed while being opened" };
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const r = readSync(fd, buf, got, want - got, offset + got);
      if (r <= 0) break;
      got += r;
    }
    if (got < want) return { data: null, why: `shorter than claimed (read ${got})` };
    return { data: buf };
  } catch (e) {
    return { data: null, why: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Folders a temporary file (t=t) may be deleted from: the system's temporary folders. */
export function tempFolders(): string[] {
  const dirs = [tmpdir(), process.env.TMPDIR ?? "", "/tmp", "/var/tmp", "/dev/shm"].filter(Boolean);
  return [...new Set(dirs.flatMap((d) => [normalize(d).replace(/\/+$/, ""), realOrSame(d).replace(/\/+$/, "")]))];
}

/**
 * The path to delete a temporary file by, after reading, or null if it
 * stays: in a temporary folder, with the protocol's marker in its path
 * (76). It's the checked folder's real path, so a folder swapped for a
 * symlink after the check can't move the delete elsewhere.
 */
export function tempToDelete(path: string): string | null {
  if (!path.includes("tty-graphics-protocol")) return null;
  const dir = realOrSame(dirname(path));
  return tempFolders().some((t) => dir === t || dir.startsWith(`${t}/`)) ? join(dir, basename(path)) : null;
}

export function deletableTemp(path: string): boolean {
  return tempToDelete(path) !== null;
}

// --- the store ---

export interface StoredImage {
  /** Its command's keys and quietness, for a failure found when it's decoded. */
  reply?: { keys: Map<string, string>; q: number };
  id: number;
  /** kitty's image number (I), 0 if none. */
  number: number;
  width: number;
  height: number;
  /** PNG bytes, decoded when drawn; or null for raw pixels. */
  png: Uint8Array | null;
  /** RGBA pixels, four bytes each; or null for a PNG. */
  rgba: Uint8Array | null;
  /** What it counts against the cap: its data, its decoded pixels (raw pixels are held twice, as data and decoded), its bookkeeping and its placements'. */
  bytes: number;
  /** When it was stored, in order. */
  serial: number;
  /** When it was last drawn, in the same order. */
  used: number;
}

export interface Placement {
  /** 0: from the picture's size and the cell size. */
  cols: number;
  rows: number;
}

export interface GraphicsHost {
  /** A reply to the program, through the terminal's input. */
  reply(text: string): void;
  /** Which of these images cells in this terminal (the scrollback included) still show: one pass for all. */
  inUse?(ids: number[]): Set<number>;
  /** An image left the store; replaced: new data came under its id, so its old pixels can show until the new ones are ready. */
  dropped?(img: StoredImage, replaced?: boolean): void;
  /** What happened, in order, for the self-test. */
  log?(event: string): void;
  /** Told every file path opened. */
  opened?(path: string): void;
}

/** Ids for images a program named only by number (I), out of the way of ids programs choose. */
const ASSIGNED_BASE = 0xfff00000;

/**
 * One terminal's pictures: what each graphics command does to them, and
 * the reply it gets. Pictures belong to their terminal.
 */
export class KittyGraphics {
  readonly images = new Map<number, StoredImage>();
  /** Virtual placements (U=1), by image id, then placement id (0 for none). */
  readonly placements = new Map<number, Map<number, Placement>>();
  stored = 0;
  /** Freed by an uppercase delete while cells still showed them: freed once they don't. */
  readonly pendingFree = new Set<number>();
  private serial = 0;
  private nextAssigned = ASSIGNED_BASE;
  private upload: { keys: Map<string, string>; parts: string[]; size: number; q: number } | null = null;
  /** Counts, for the self-test: how many commands were handled, and how many pictures decoded from data. */
  readonly counts = { commands: 0, refusedForSize: 0, decodedChecks: 0 };

  constructor(private host: GraphicsHost, readonly limit = PICTURE_LIMIT, readonly cap = STORE_CAP) {}

  private log(e: string): void {
    this.host.log?.(e);
  }

  touch(img: StoredImage): void {
    img.used = ++this.serial;
  }

  /** Everything gone: the setting turned off, or the terminal closed. */
  clear(): void {
    for (const img of this.images.values()) this.host.dropped?.(img);
    this.images.clear();
    this.placements.clear();
    this.pendingFree.clear();
    this.stored = 0;
    this.upload = null;
  }

  handle(body: string): void {
    this.counts.commands++;
    pictureCalls.commands++;
    let cmd = parseCommand(body);
    if (this.upload) {
      const extra = [...cmd.keys.keys()].filter((k) => k !== "m" && k !== "q");
      if (!extra.length) {
        const up = this.upload;
        const more = num(cmd.keys, "m") === 1;
        up.parts.push(cmd.payload);
        up.size += cmd.payload.length + CHUNK_COST;
        if (cmd.keys.has("q")) up.q = num(cmd.keys, "q");
        if (!chunkIsBase64(cmd.payload, more)) {
          this.upload = null;
          this.log("malformed chunk: upload dropped");
          this.answer(up.keys, up.q, "EINVAL:the data isn't base64");
          return;
        }
        if (up.size > Math.ceil((this.limit * 4) / 3) + 4096) {
          this.upload = null;
          this.log("upload too large: dropped");
          this.answer(up.keys, up.q, READ_ERROR);
          return;
        }
        if (more) return;
        this.upload = null;
        const keys = new Map(up.keys);
        keys.delete("m");
        cmd = { keys, payload: up.parts.join("") };
        this.run(cmd, up.q);
        return;
      }
      this.upload = null;
      this.log("upload aborted by another command");
    }
    const a = cmd.keys.get("a") ?? "t";
    const t = cmd.keys.get("t") ?? "d";
    if (num(cmd.keys, "m") === 1 && (a === "t" || a === "T" || a === "q") && t === "d") {
      if (!chunkIsBase64(cmd.payload, true)) return this.answer(cmd.keys, num(cmd.keys, "q"), "EINVAL:the data isn't base64");
      this.upload = { keys: cmd.keys, parts: [cmd.payload], size: cmd.payload.length + CHUNK_COST, q: num(cmd.keys, "q") };
      return;
    }
    this.run(cmd, num(cmd.keys, "q"));
  }

  /** A stored PNG failed to load when decoded: it goes, with the error reply its command asked for. */
  failedToLoad(img: StoredImage): void {
    if (this.images.get(img.id) !== img) return;
    this.drop(img.id);
    this.placements.delete(img.id);
    this.log(`dropped ${img.id}: the PNG doesn't load`);
    if (img.reply) this.answer(img.reply.keys, img.reply.q, "EBADPNG:the PNG doesn't load", img.id);
  }

  /** A command cut short by CAN, SUB, an escape or the size limit: an upload it continued is dropped with it. */
  cancelled(why: string): void {
    if (!this.upload) return;
    this.upload = null;
    this.log(`upload cancelled: ${why}`);
  }

  private answer(keys: Map<string, string>, q: number, message: string, id?: number): void {
    const i = id ?? num(keys, "i");
    const I = num(keys, "I");
    if (!i && !I) return;
    const ok = message === "OK";
    if ((ok && q >= 1) || q >= 2) return;
    const p = num(keys, "p");
    this.host.reply(`\x1b_Gi=${i}${I ? `,I=${I}` : ""}${p ? `,p=${p}` : ""};${message}\x1b\\`);
  }

  private run(cmd: Command, q: number): void {
    const { keys } = cmd;
    const a = keys.get("a") ?? "t";
    if (keys.has("i") && keys.has("I")) return this.answer(keys, q, "EINVAL:i and I given together");
    if (a === "d") return this.remove(keys);
    if (a === "p") return this.place(keys, q, null);
    if (a === "t" || a === "T" || a === "q") return this.transmit(cmd, q, a);
    if (a === "f" || a === "a" || a === "c") return this.answer(keys, q, "ENOTSUP:animation frames aren't supported");
    this.answer(keys, q, "EINVAL:unknown action");
  }

  private transmit(cmd: Command, q: number, a: string): void {
    const { keys } = cmd;
    const f = keys.has("f") ? num(keys, "f") : 32;
    const t = keys.get("t") ?? "d";
    if (f !== 24 && f !== 32 && f !== 100) return this.answer(keys, q, "EINVAL:unknown format");
    const bpp = f === 24 ? 3 : 4;
    // Raw pixels' size is known from the keys before anything is read.
    if (f !== 100) {
      const s = num(keys, "s");
      const v = num(keys, "v");
      if (s <= 0 || v <= 0) return this.answer(keys, q, "EINVAL:width and height are needed");
      if (s * v * 4 > this.limit) return this.refuseSize(keys, q, `${s}x${v} claimed`);
    }
    let data: Uint8Array | null;
    if (t === "d") {
      data = base64(cmd.payload);
      if (!data) return this.answer(keys, q, "EINVAL:the data isn't base64");
    } else if (t === "f" || t === "t") {
      const path = base64(cmd.payload)?.toString("utf8") ?? "";
      const read = path ? readPictureFile(path, num(keys, "S"), num(keys, "O"), this.limit, (p) => this.host.opened?.(p)) : { data: null, why: "no path" };
      const doomed = t === "t" && path ? tempToDelete(path) : null;
      if (doomed) {
        try {
          unlinkSync(doomed);
        } catch {
          // already gone
        }
      }
      if (!read.data) {
        this.log(`file not read: ${read.why}`);
        return this.answer(keys, q, READ_ERROR);
      }
      data = read.data;
    } else {
      // Shared memory (t=s) isn't read: the spike saw claude never use it.
      return this.answer(keys, q, READ_ERROR);
    }
    if (keys.get("o") === "z") {
      try {
        data = inflateSync(data, { maxOutputLength: this.limit });
      } catch {
        return this.answer(keys, q, "EINVAL:couldn't decompress the data");
      }
    }
    let width: number;
    let height: number;
    let png: Uint8Array | null = null;
    let rgba: Uint8Array | null = null;
    if (f === 100) {
      const size = pngSize(data);
      if (!size) return this.answer(keys, q, "EBADPNG:not a PNG");
      if (size.width * size.height * 4 > this.limit) return this.refuseSize(keys, q, `PNG header says ${size.width}x${size.height}`);
      ({ width, height } = size);
      // A query is answered now, so its PNG is loaded now. A picture sent
      // is loaded when it's decoded, off the main thread, which reports a
      // failure then (failedToLoad): inflating a large PNG here would stall
      // the window, and the decode would do it again anyway.
      if (a === "q" && !pngLoads(data, width, height)) return this.answer(keys, q, "EBADPNG:the PNG doesn't load");
      png = data;
    } else {
      width = num(keys, "s");
      height = num(keys, "v");
      if (data.length < width * height * bpp) return this.answer(keys, q, "ENODATA:Insufficient image data");
      this.counts.decodedChecks++;
      // A copy of exactly the pixels: a view would keep all the data received alive.
      rgba = bpp === 4 ? new Uint8Array(data.subarray(0, width * height * 4)) : rgbToRgba(data, width * height);
    }
    if (a === "q") return this.answer(keys, q, "OK");
    let id = num(keys, "i");
    const number = num(keys, "I");
    if (!id && number) id = this.nextAssigned++;
    if (id && this.images.has(id)) {
      // Re-sent data replaces the image, and all its placements go.
      this.drop(id, true);
      this.placements.delete(id);
      this.log(`replaced ${id}`);
    }
    // Only the keys a reply uses: a command's other keys can be any size, and nothing counts them.
    const replyKeys = new Map([...keys].filter(([k]) => k === "i" || k === "I" || k === "p"));
    const img: StoredImage = { reply: { keys: replyKeys, q }, id, number, width, height, png, rgba, bytes: IMAGE_COST + (png ? png.length + width * height * 4 : width * height * 8), serial: ++this.serial, used: this.serial };
    if (id) {
      this.images.set(id, img);
      this.stored += img.bytes;
      this.evict(id);
    }
    this.log(`stored ${id} ${width}x${height} ${png ? "png" : "rgba"}`);
    if (a === "T") return this.place(keys, q, id);
    this.answer(keys, q, "OK", id);
  }

  private refuseSize(keys: Map<string, string>, q: number, what: string): void {
    this.counts.refusedForSize++;
    this.log(`refused for size before decoding: ${what}`);
    this.answer(keys, q, READ_ERROR);
  }

  private find(keys: Map<string, string>, id: number | null): StoredImage | undefined {
    if (id) return this.images.get(id);
    const i = num(keys, "i");
    if (i) return this.images.get(i);
    const I = num(keys, "I");
    if (!I) return undefined;
    let newest: StoredImage | undefined;
    for (const img of this.images.values()) if (img.number === I && (!newest || img.serial > newest.serial)) newest = img;
    return newest;
  }

  private place(keys: Map<string, string>, q: number, id: number | null): void {
    const img = this.find(keys, id);
    if (!img) return this.answer(keys, q, "ENOENT:no such image");
    if (num(keys, "U") !== 1) return this.answer(keys, q, "ENOTSUP:only Unicode placeholder placements are supported", img.id);
    let map = this.placements.get(img.id);
    if (!map) this.placements.set(img.id, (map = new Map<number, Placement>()));
    const pid = num(keys, "p");
    if (!map.has(pid)) {
      this.cost(img, PLACEMENT_COST);
      if (map.size >= PLACEMENTS_KEPT) {
        map.delete(map.keys().next().value!);
        this.cost(img, -PLACEMENT_COST);
      }
    }
    map.set(pid, { cols: num(keys, "c"), rows: num(keys, "r") });
    this.touch(img);
    this.evict(img.id);
    this.answer(keys, q, "OK", img.id);
  }

  /**
   * Deletes, as kitty specifies: only i, I, r, R, n and N reach
   * virtual placements, which are the only placements here, so every other
   * kind deletes nothing. Lowercase keeps the data; uppercase frees it
   * unless cells still show it.
   */
  private remove(keys: Map<string, string>): void {
    const d = keys.get("d") ?? "a";
    const free = d === d.toUpperCase();
    const p = keys.has("p") ? num(keys, "p") : null;
    let ids: number[] = [];
    switch (d.toLowerCase()) {
      case "i":
        ids = [num(keys, "i")];
        break;
      case "n": {
        const img = this.find(new Map([["I", keys.get("I") ?? ""]]), null);
        ids = img ? [img.id] : [];
        break;
      }
      case "r": {
        const x = num(keys, "x");
        const y = num(keys, "y");
        ids = [...this.images.keys(), ...this.placements.keys()].filter((k) => k >= x && k <= y);
        break;
      }
      default:
        this.log(`delete d=${d}: nothing placed by position`);
        return;
    }
    const toFree: number[] = [];
    for (const id of new Set(ids)) {
      const map = this.placements.get(id);
      if (map) {
        const before = map.size;
        if (p !== null && d.toLowerCase() !== "r") map.delete(p);
        else map.clear();
        const img = this.images.get(id);
        if (img) this.cost(img, (map.size - before) * PLACEMENT_COST);
        if (!map.size) this.placements.delete(id);
      }
      if (free && !this.placements.has(id) && this.images.has(id)) toFree.push(id);
      else this.log(`delete ${d} ${id}${p !== null ? ` p=${p}` : ""}: placements removed`);
    }
    if (!toFree.length) return;
    // One look through the scrollback for all of them.
    const shown = this.host.inUse?.(toFree) ?? new Set<number>();
    for (const id of toFree) {
      if (shown.has(id)) {
        this.pendingFree.add(id);
        this.log(`delete ${d} ${id}: kept while cells still show it`);
      } else {
        this.drop(id);
        this.log(`delete ${d} ${id}: freed`);
      }
    }
  }

  /** Frees what an uppercase delete left while cells still showed it, once none do: one look for all of them. */
  sweep(): void {
    for (const id of this.pendingFree) if (this.placements.has(id) || !this.images.has(id)) this.pendingFree.delete(id);
    if (!this.pendingFree.size) return;
    const shown = this.host.inUse?.([...this.pendingFree]) ?? new Set<number>();
    for (const id of [...this.pendingFree]) {
      if (shown.has(id)) continue;
      this.drop(id);
      this.log(`freed ${id}: no cells show it now`);
    }
  }

  /** Adds to what a picture counts against the cap. */
  private cost(img: StoredImage, n: number): void {
    img.bytes += n;
    if (this.images.get(img.id) === img) this.stored += n;
  }

  private drop(id: number, replaced = false): void {
    this.pendingFree.delete(id);
    const img = this.images.get(id);
    if (!img) return;
    this.images.delete(id);
    this.stored -= img.bytes;
    this.host.dropped?.(img, replaced);
  }

  /**
   * Past the cap, images with no placements go first, oldest first (kitty's
   * rule), then the least recently drawn; never the one just stored.
   */
  private evict(keep: number): void {
    if (this.stored <= this.cap) return;
    const order = [...this.images.values()]
      .filter((img) => img.id !== keep)
      .sort((x, y) => Number(this.placements.has(x.id)) - Number(this.placements.has(y.id)) || x.used - y.used);
    for (const img of order) {
      if (this.stored <= this.cap) break;
      this.drop(img.id);
      this.placements.delete(img.id);
      this.log(`evicted ${img.id}`);
    }
  }
}

/** One chunk of a chunked upload is base64 by itself; every chunk but the last a whole number of groups. */
function chunkIsBase64(text: string, more: boolean): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return false;
  return more ? text.length % 4 === 0 && !text.includes("=") : text.length % 4 !== 1;
}

function rgbToRgba(rgb: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  for (let k = 0, j = 0; k < pixels; k++, j += 3) {
    out[k * 4] = rgb[j];
    out[k * 4 + 1] = rgb[j + 1];
    out[k * 4 + 2] = rgb[j + 2];
    out[k * 4 + 3] = 255;
  }
  return out;
}

// --- placeholders ---

export interface PlaceholderCell {
  /** The image id: the foreground color, plus a third mark's byte on top. */
  id: number;
  /** The placement id, from the underline color; 0 for any. */
  placement: number;
  row: number;
  col: number;
}

export interface CellColors {
  /** The foreground color as sent: a 256-color index or a 24-bit value; -1 for the default. */
  fg: number;
  /** The underline color as sent, -1 for none. */
  underline: number;
}

/**
 * Reads one placeholder cell, given its marks and colors and the cell to
 * its left, if that was a placeholder too. Missing marks are inherited from
 * the left by kitty's three rules; otherwise they count as 0.
 */
export function readPlaceholder(marks: number[], colors: CellColors, left: (PlaceholderCell & { colors: CellColors; msb: number }) | null): PlaceholderCell & { colors: CellColors; msb: number } {
  const same = !!left && left.colors.fg === colors.fg && left.colors.underline === colors.underline;
  let row = marks[0] ?? 0;
  let col = marks[1] ?? 0;
  let msb = marks[2] ?? 0;
  if (marks.length === 0 && same) {
    row = left.row;
    col = left.col + 1;
    msb = left.msb;
  } else if (marks.length === 1 && same && left.row === row) {
    col = left.col + 1;
    msb = left.msb;
  } else if (marks.length === 2 && same && left.row === row && left.col + 1 === col) {
    msb = left.msb;
  }
  const fg = colors.fg < 0 ? 0 : colors.fg;
  return { id: fg + msb * 0x1000000, placement: Math.max(0, colors.underline), row, col, msb, colors };
}
