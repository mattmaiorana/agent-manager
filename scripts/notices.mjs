// The third-party notices that travel with every install. An install gets only main.js,
// styles.css, and manifest.json, so the notices go into the first two as comments, and
// into THIRD_PARTY_NOTICES in the repo. Read from the installed packages' own LICENSE
// files, so they follow a version bump.
//   node scripts/notices.mjs   rewrite THIRD_PARTY_NOTICES
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Every package bundled into main.js or styles.css.
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

// The notices as a comment for the top of a built file.
export function noticeComment(nodeModules = "node_modules") {
  return `/*\n${notices(nodeModules)}*/`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync("THIRD_PARTY_NOTICES", notices());
}
