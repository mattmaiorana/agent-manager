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
    // The Claude mod: Claude Code runs it, not Obsidian, and it ships as text in main.js.
    "claude-mod",
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
  {
    // All of src/'s TypeScript, the terminal's included (the self-test is ignored above):
    // values typed `any` are errors, so the types can't slide back.
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
);
