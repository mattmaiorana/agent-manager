
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function hasError<T extends object>(result: T): result is Extract<T, { error: string }> {
  return "error" in result && !!result.error;
}
function errorMessage(e: unknown): unknown {
  return (e as { message?: unknown } | null | undefined)?.message || e;
}
type Stringable = string | number | boolean | bigint | symbol | null | undefined | { toString(): string };
function stringOf(value: unknown): string {
  const given = value as Stringable;
  return String(given);
}
function withinVault(value: string): string {
  return value.split(/[\\/]/).includes("..") ? "" : value;
}
export { errorMessage, hasError, isArray, stringOf, withinVault };
