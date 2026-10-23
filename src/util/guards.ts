// Type guards for values read from disk: the same tests the code always made, typed.

// Array.isArray, giving unknown[] rather than any[].
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
// A result that carries an error, as the terminal's lookups return one: the same test as
// `if (result.error)`.
function hasError<T extends object>(result: T): result is Extract<T, { error: string }> {
  return "error" in result && !!result.error;
}
// What `e?.message || e` gives for a caught value: its message, else the value itself.
function errorMessage(e: unknown): unknown {
  return (e as { message?: unknown } | null | undefined)?.message || e;
}
// String(value), for a value read from disk or caught: the same call. Its type says what
// String() is given (any object has a toString), which is what the lint asks for.
type Stringable = string | number | boolean | bigint | symbol | null | undefined | { toString(): string };
function stringOf(value: unknown): string {
  const given = value as Stringable;
  return String(given);
}
// A vault path from a setting, or "" when it would reach outside the vault (a ".."
// part). Settings are checked as they're typed; this covers a data.json edited by hand.
function withinVault(value: string): string {
  return value.split(/[\\/]/).includes("..") ? "" : value;
}
export { errorMessage, hasError, isArray, stringOf, withinVault };
