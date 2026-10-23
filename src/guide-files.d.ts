// The guides, which the build bundles as text (esbuild.config.mjs, guideFiles): each
// file's name inside guides/ to its text.
declare module "guide-files" {
  const files: Record<string, string>;
  export default files;
}
// The starter skills, bundled the same way (esbuild.config.mjs, starterSkills): each file's
// path inside skills/ to its text.
declare module "skill-files" {
  const files: Record<string, string>;
  export default files;
}
