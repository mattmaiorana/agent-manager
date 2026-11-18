
const SAFE_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "fish", "powershell", "ps1", "bat", "cmd",
  "js", "javascript", "jsx", "ts", "typescript", "tsx", "mjs", "cjs", "json", "jsonc", "json5",
  "py", "python", "rb", "ruby", "go", "rust", "rs", "java", "kotlin", "kt", "swift", "c", "h",
  "cpp", "c++", "cc", "hpp", "cs", "csharp", "php", "lua", "perl", "pl", "r", "scala", "dart",
  "elixir", "ex", "erlang", "haskell", "hs", "clojure", "ocaml", "zig", "nim", "julia",
  "html", "xml", "svg", "css", "scss", "sass", "less", "vue", "svelte",
  "sql", "graphql", "gql", "yaml", "yml", "toml", "ini", "env", "dockerfile", "docker",
  "make", "makefile", "cmake", "nginx", "diff", "patch", "md", "markdown", "text", "txt",
  "plaintext", "log", "csv", "tsv", "regex", "applescript", "latex", "tex", "mermaid",
]);

export function neutralizeFences(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const m = /^((?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])[ \t]?)*[ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) return line;
      const [, lead, fence, rest] = m;
      if (fence[0] === "`" && rest.includes("`")) return line;
      const lang = rest.trim().split(/\s+/)[0].toLowerCase();
      return lang && !SAFE_LANGS.has(lang) ? `${lead}${fence}` : line;
    })
    .join("\n")
    .replace(/`(\$?=)/g, "`​$1");
}

export function imagesToLinks(md: string): string {
  return md
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/!+(\[)/g, "$1")))
    .join("");
}

export function markImageLinks(md: string): string {
  const name = (alias: string | undefined, target: string) => (alias && !/^\d+(?:x\d+)?$/.test(alias.trim()) ? alias : target.replace(/^.*\//, ""));
  return md
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part
      .split("\n")
      .map((line) => {
        const pipe = /^\s*\|/.test(line) ? "\\|" : "|";
        return line
          .replace(/!+\[\[([^\]|\\]+)(?:\\?\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => `[[${target}${pipe}\u2063${name(alias, target)}]]`)
          .replace(/!+\[([^\]]*)\]\(/g, (_m, alt: string) => `[\u2063${alt}](`)
          .replace(/!+(\[)/g, "$1");
      })
      .join("\n")))
    .join("");
}

const RISKY_TAGS = "img|image|video|audio|source|track|picture|iframe|frame|frameset|embed|object|applet|svg|math|link|style|meta|base|script|noscript|form|input|button|body|table|td|th|marquee";

export function escapeRiskyHtml(md: string): string {
  const risky = new RegExp(`<(?=\\/?(?:${RISKY_TAGS})\\b)`, "gi");
  return md
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part
      .replace(risky, "&lt;")
      .replace(/<(?=[a-z][^>]*?\b(?:style\s*=\s*["'][^"']*(?:url\s*\(|image-set|@import)|background\s*=))/gi, "&lt;")))
    .join("");
}

export function isLocalSrc(src: string): boolean {
  const s = src.trim();
  if (s.startsWith("//")) return false;
  return /^(?:app|capacitor|data|blob):/i.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

const FETCH_ATTRS = ["src", "srcset", "poster", "data", "background", "href", "xlink:href", "action", "formaction", "ping"];

export function sanitizeRendered(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll("style, link, meta, base, script, noscript, form, template"))) el.remove();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("img, video, audio, source, track, iframe, frame, embed, object, picture, input"))) {
    const src = el.getAttribute("src") ?? el.getAttribute("data") ?? el.getAttribute("srcset")?.split(/[\s,]+/)[0] ?? "";
    const poster = el.getAttribute("poster");
    const srcset = el.getAttribute("srcset");
    const remoteSet = !!srcset && srcset.split(",").some((part) => !isLocalSrc(part.trim().split(/\s+/)[0] ?? ""));
    const local = !!src && isLocalSrc(src) && !remoteSet && (!poster || isLocalSrc(poster));
    if (local && !["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(el.tagName)) continue;
    const a = createEl("a");
    a.textContent = el.getAttribute("alt") || src || el.tagName.toLowerCase();
    if (src && /^https?:/i.test(src)) { a.setAttribute("href", src); a.className = "external-link"; a.setAttribute("rel", "noopener nofollow"); a.setAttribute("target", "_blank"); }
    el.replaceWith(a);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const style = el.getAttribute("style");
    if (style && /url\s*\(|image-set|@import|expression\s*\(/i.test(style)) el.removeAttribute("style");
    for (const attr of FETCH_ATTRS) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      if (/^\s*(?:javascript|vbscript):/i.test(v)) { el.removeAttribute(attr); continue; }
      if (attr === "href" && el.tagName === "A") continue;
      if (!isLocalSrc(v)) el.removeAttribute(attr);
    }
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
}
