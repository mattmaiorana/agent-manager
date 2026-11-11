
function ticketFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+\s*/, "");
}

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
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  let start = close + 1;
  while (start < lines.length && lines[start].trim() === "") start++;
  lines.splice(close + 1, start - close - 1, body, "");
  return lines.join("\n");
}

export { ticketFileName, withNotes };
