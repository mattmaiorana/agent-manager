import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUNDLED = ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-search", "@xterm/addon-unicode11"];

export function notices(nodeModules = "node_modules") {
  const parts = BUNDLED.map((name) => {
    const dir = join(nodeModules, name);
    const { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const text = readFileSync(join(dir, "LICENSE"), "utf8").trim();
    if (text.includes("*/")) throw new Error(`${name}'s LICENSE would end a CSS or JS comment`);
    return `${name} ${version} (${license})\n\n${text}`;
  });
  return `Agent Manager includes the following third-party software.\n\n${parts.join("\n\n----------------------------------------\n\n")}\n`;
}

export function noticeComment(nodeModules = "node_modules") {
  return `/*\n${notices(nodeModules)}*/`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync("THIRD_PARTY_NOTICES", notices());
}
