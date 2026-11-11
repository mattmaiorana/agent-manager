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
    rules: {
      "import/no-extraneous-dependencies": ["warn", { packageDir: [import.meta.dirname] }],
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: [...DEFAULT_BRANDS, "Agent Manager", "Claude Code", "Codex", "Antigravity", "Python", "Dock", "Documents", "Option", "Remote Control", "Latest Outputs"],
        ignoreWords: ["Enter", "S", "Meta", "MB", "MCP", "NAME", "Private", "Work", "Scheduled", "Tasks"],
        ignoreRegex: ["^~/", "^[A-Z_]+="],
      }],
    },
  },
  {
    files: ["src/constants/scheduled.ts"],
    rules: { "obsidianmd/hardcoded-config-path": "off" },
  },
  {
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
