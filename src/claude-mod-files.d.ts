// The Claude mod's files, which the build bundles as text (esbuild.config.mjs, claudeMod):
// each file's path inside claude-mod/ to its text.
declare module "claude-mod-files" {
  const files: Record<string, string>;
  export default files;
}
