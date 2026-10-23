// Tests reading the files a Claude session sent from its transcript (src/transcripts/sent-files.ts):
// node scripts/run-test.mjs scripts/test-sent-files.mjs
import { sentFilesIn, sentFileMarker } from "../src/transcripts/sent-files.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};
const use = (id, files) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SendUserFile", id, input: { files } }] } });
const result = (id, paths, extra = {}) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "delivered", ...extra }] }, toolUseResult: { attachments: paths.map((p) => ({ path: p, pathValidated: true })) } });
const other = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, toolUseResult: { attachments: [{ path: "/not/sent.png" }] } });

check("two files", sentFilesIn([use("a", ["/1.png", "/2.pdf"]), result("a", ["/1.png", "/2.pdf"])].join("\n")), [{ key: "a:0", path: "/1.png" }, { key: "a:1", path: "/2.pdf" }]);
check("a result twice", sentFilesIn([use("a", ["/1.png"]), result("a", ["/1.png"]), result("a", ["/1.png"])].join("\n")).length, 1);
check("no result yet", sentFilesIn(use("a", ["/1.png"])), []);
check("an error", sentFilesIn([use("a", ["/1.png"]), result("a", ["/1.png"], { is_error: true })].join("\n")), []);
check("another tool's attachments", sentFilesIn(other), []);
check("junk lines", sentFilesIn("not json SendUserFile\n{\"attachments\": 1}"), []);
check("marker", sentFileMarker("a:0"), "<!-- pl-file:a:0 -->");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
