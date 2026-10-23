# The bundled Claude mod

`inline-images/` is a Claude Code mod (a plugin whose hooks module draws inside Claude Code): the PNGs a Claude session sends are drawn as framed pictures in the terminal, with Open, Save to Downloads, and Copy path. Its look and some of its speed-ups come from show-your-work (MIT; `inline-images/THIRD_PARTY_NOTICES.md`).

**How it ships.** The build bundles these files into `main.js` as text (`esbuild.config.mjs`, the `claude-mod-files` module). On load the plugin writes them into its own folder, `<vault>/.obsidian/plugins/agent-manager/claude-mod/inline-images/`, only when they differ (`src/plugin/claude-mod.ts`), and every Claude start and resume gets `--plugin-dir` pointing there while "Show pictures" is on (`src/sessions/controller.ts`). Nothing is downloaded, and nothing is written to `~/.claude`.

**Checking it.** `claude plugin validate claude-mod/inline-images`. To type-check, copy the Claude Code build's API types to `inline-images/.claude-plugin/types/claude-code/index.d.ts` (not tracked: Claude Code's `plugin-authoring` skill names the file) and run `npx tsc -p claude-mod/inline-images`.
