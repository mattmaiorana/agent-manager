// Small decisions about keys, kept free of Obsidian and xterm so
// test/harness.ts can check them.

/** The parts of a key event these decisions read. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether Ctrl+C copies the terminal's selection instead of going to the
 * program as the interrupt (a setting, off by default).
 * Off ("Ctrl+C always interrupts" unset), Ctrl+C copies only when the
 * terminal has a selection of its own, and otherwise interrupts. On, it
 * always interrupts. Never the program's copy (Super+C): with nothing
 * selected, Ctrl+C must stay the way to interrupt Claude.
 */
export function ctrlCCopies(e: KeyLike, hasSelection: boolean, alwaysInterrupts: boolean): boolean {
  const ctrlC = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c";
  return ctrlC && hasSelection && !alwaysInterrupts;
}

/** What a key typed after the program ended does. */
export type AfterExit = "restart" | "shell" | "nothing";

/**
 * After the program ends, Enter starts it again and S starts a shell. A
 * terminal a host controls never gets the shell (a session tab with its
 * strip and controls would be holding a shell instead), and its Enter goes
 * to the host, which may refuse it.
 */
export function afterExitKey(data: string, hosted: boolean): AfterExit {
  if (data === "\r") return "restart";
  if (!hosted && data.toLowerCase() === "s") return "shell";
  return "nothing";
}
