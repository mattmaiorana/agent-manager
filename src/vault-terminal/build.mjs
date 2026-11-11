import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function withVaultTerminal(options = {}, nodeModules = "node_modules") {
  return {
    ...options,
    loader: { ...options.loader, ".py": "text" },
    define: { ...options.define, XTERM_VERSION: JSON.stringify(xtermVersion(nodeModules)) },
    plugins: [...(options.plugins ?? []).filter((p) => p !== xtermInBrowser), xtermInBrowser],
  };
}

export function xtermVersion(nodeModules = "node_modules") {
  return JSON.parse(readFileSync(join(nodeModules, "@xterm/xterm/package.json"), "utf8")).version;
}

export function vaultTerminalStyles(nodeModules = "node_modules") {
  const xterm = readFileSync(join(nodeModules, "@xterm/xterm/css/xterm.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  if (xterm.includes("@")) throw new Error("xterm.css now has an at-rule; teach vaultTerminalStyles to lift it out");
  const own = readFileSync(join(here, "styles.css"), "utf8");
  return `${own.trim()}\n\n/* xterm.js 6 */\n.vault-terminal-view {\n${xterm.trim()}\n}\n`;
}

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
