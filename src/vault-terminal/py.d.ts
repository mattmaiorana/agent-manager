// esbuild's text loader turns a .py import into its source string.
declare module "*.py" {
  const source: string;
  export default source;
}
