// Obsidian's community review rules (eslint-plugin-obsidianmd), run with `npm run lint`
// on every change, so what the review would flag shows up here first. It lints what
// ships: src/ (but the self-test, which no build includes) and manifest.json.
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    ".build",
    "main.js",
    "styles.css",
    "esbuild.config.mjs",
    "eslint.config.mjs",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts",
    "test",
    "src/selftest",
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["manifest.json"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    // The sentence-case rule with this plugin's proper nouns added to its defaults (a
    // list given here replaces them, so they're spread in): the CLIs, the plugin's own
    // name, and the macOS names its settings use.
    rules: {
      // Dependencies are the root package.json's: src/package.json only marks src/ as ES
      // modules, and is otherwise the nearest one the rule would read.
      "import/no-extraneous-dependencies": ["warn", { packageDir: [import.meta.dirname] }],
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: [...DEFAULT_BRANDS, "Agent Manager", "Claude Code", "Codex", "Antigravity", "Python", "Dock", "Option", "Remote Control"],
        // Key names, a unit, and a placeholder's syntax.
        ignoreWords: ["Enter", "S", "Meta", "MB", "NAME"],
        ignoreRegex: ["^~/", "^[A-Z_]+="],
      }],
    },
  },
);
