Replace content in a UTF-8 text file using `LINE#HASH` anchors copied verbatim from `read`. The entire anchor range is deleted and only `lines` survives — if you want to keep any original lines from the range, you must copy them into `lines`.

Submit one `edit` call per file. All operations go in a single `edits` array; anchors must come from the same fresh source — the most recent `read` or diff output of a successful `edit` on this file.

Each edit entry drops the current anchor range and replaces it with `lines`:
```json
{ "range": [startAnchor, endAnchor], "lines": [...] }
```
- `range` — `[start, end]` pair of LINE#HASH anchors from the most recent `read` or diff output.
  Use the same anchor twice for single-line: `["42#A4", "42#A4"]`.
- `lines` — replacement content (string array). The range is wiped and replaced by exactly these lines. Copy any original lines you want to keep. Use `[]` to delete.
  Must be literal file content, not LINE#HASH│-prefixed output. Match indentation exactly.

Example:
```json
{ "path": "src/main.ts", "edits": [
  { "range": ["12#3F", "12#3F"], "lines": ["const x = 1;"] },
  { "range": ["20#B2", "25#C7"], "lines": ["function foo() {", "  return 42;", "}"] }
] }

Rules:
- Do not guess or construct anchors. Copy them from the most recent `read` or diff output of this file.
- Do not emit overlapping or adjacent edits — merge them into one.
