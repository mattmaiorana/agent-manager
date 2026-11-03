// A new ticket from the New ticket card (plugin/tickets.ts, newTicket): its file name
// from the name typed, and the notes typed placed under the notes heading. Pure, tested
// in Node (scripts/test-new-ticket.mjs).

// A file name from the name typed: the characters a file name or a link can't carry
// become spaces, runs of spaces one, and no leading dot. Empty when nothing is left.
function ticketFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+\s*/, "");
}

// The template's text with the notes in it. Under a heading when one is set and the
// template has it: after the first line that is the heading (trimmed), the blank lines
// there give way to the notes, a blank line either side. Otherwise first, right under
// the properties (or at the top, with none), a blank line after them. With no notes,
// the text as it was.
function withNotes(text: string, heading: string, notes: string): string {
  const body = notes.replace(/\r\n?/g, "\n").trim();
  if (!body) return text;
  const h = heading.trim();
  const lines = text.split("\n");
  const at = h ? lines.findIndex((l) => l.trim() === h) : -1;
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && lines[end].trim() === "") end++;
    lines.splice(at + 1, end - at - 1, "", body, "");
    return lines.join("\n");
  }
  // The line after the properties' closing ---, when the note opens with properties.
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  let start = close + 1;
  while (start < lines.length && lines[start].trim() === "") start++;
  lines.splice(close + 1, start - close - 1, body, "");
  return lines.join("\n");
}

export { ticketFileName, withNotes };
