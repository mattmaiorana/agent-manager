
function isArchived(path: string): boolean {
  return path.split("/").includes("Archive");
}
export { isArchived };
