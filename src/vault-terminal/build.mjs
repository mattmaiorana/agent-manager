// What any host plugin's esbuild build needs to bundle vault-terminal
// (PORTING.md): the helper inlined as text, xterm's CSS under the terminal's
// class, xterm's browser check corrected, and xterm's version for the
// XTVERSION answer. The plugin's esbuild.config.mjs uses exactly these.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The host's esbuild options with the terminal's merged in: the helper as
 * text (loader), XTERM_VERSION (define), and the xterm browser check
 * (plugins), each added to what the host has, never replacing it.
 */
export function withVaultTerminal(options = {}, nodeModules = "node_modules") {
  return {
    ...options,
    loader: { ...options.loader, ".py": "text" },
    define: { ...options.define, XTERM_VERSION: JSON.stringify(xtermVersion(nodeModules)) },
    plugins: [...(options.plugins ?? []).filter((p) => p !== xtermInBrowser), xtermInBrowser],
  };
}

/** The xterm.js actually bundled, for the XTVERSION answer. */
export function xtermVersion(nodeModules = "node_modules") {
  return JSON.parse(readFileSync(join(nodeModules, "@xterm/xterm/package.json"), "utf8")).version;
}

/**
 * The terminal's CSS: its own rules, then xterm's nested under
 * .vault-terminal-view so they touch only its terminals. A host appends
 * this to its own styles.css, or writes it as the whole file (out).
 */
export function vaultTerminalStyles(nodeModules = "node_modules") {
  const xterm = readFileSync(join(nodeModules, "@xterm/xterm/css/xterm.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Rules nest under the terminal's class; at-rules (keyframes, font faces) can't.
  // xterm 6.0.0 has none. Stop rather than guess if a later version adds one.
  if (xterm.includes("@")) throw new Error("xterm.css now has an at-rule; teach vaultTerminalStyles to lift it out");
  const own = readFileSync(join(here, "styles.css"), "utf8");
  return `${own.trim()}\n\n/* xterm.js 6 */\n.vault-terminal-view {\n${xterm.trim()}\n}\n`;
}

// xterm decides at load whether it runs in Node: if process.title exists, it
// calls the platform "node" instead of reading navigator.platform. Obsidian's
// renderer has Node, so xterm would think it isn't on a Mac, and send Option
// keys as Escape plus the key whatever macOptionIsMeta says: no @ or € on
// German or French layouts. The plugin only ever runs in a browser window, so
// the check is made false. Stops the build if a new xterm changes it.
// It also stops the build if xterm is bundled but its file was never patched
// (a new xterm moving its entry point would otherwise slip past).
export const xtermInBrowser = {
  name: "xterm-in-browser",
  setup(b) {
    let used = false;
    let patched = false;
    b.onStart(() => {
      used = false;
      patched = false;
    });
    b.onResolve({ filter: /^@xterm\/xterm$/ }, () => {
      used = true;
      return undefined;
    });
    b.onLoad({ filter: /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.m?js$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const nodeCheck = /(?:"undefined"!=typeof process|typeof process<"u")&&"title"in process/g;
      const found = source.match(nodeCheck)?.length ?? 0;
      if (found !== 1) throw new Error(`xterm's Node check appears ${found} times in ${args.path}; update xtermInBrowser`);
      patched = true;
      return { contents: source.replace(nodeCheck, "!1"), loader: "js" };
    });
    b.onEnd((result) => {
      if (used && !patched && !result.errors.length) {
        return { errors: [{ text: "xterm was bundled without its Node check corrected; update xtermInBrowser's file filter" }] };
      }
      return undefined;
    });
  },
};
