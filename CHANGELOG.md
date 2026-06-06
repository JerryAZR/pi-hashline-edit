# Changelog

## 0.8.2

### Reverted
- **Dimmed anchors in diff output.** Reverted the v0.8.1 change that split diff lines at `│` and rendered the anchor/hash in a separate color. The visual break was choppy and drew attention to metadata that should not be highlighted. Diff lines are now colored monolithically by prefix (`+` success, `-` error, ` ` dim) as before.

## 0.8.1

### Added
- **Undo tool.** Reverts the most recent hashline edit within the last 3 conversation turns. Useful when the model realizes an edit was wrong before the context window scrolls away.
- **[E_EMPTY_FILE] guard.** Rejects edits on empty files with a clear error directing the model to the write tool.
- **Dimmed anchors in diff output.** Diff rendering splits each line at `│` and renders the anchor/hash portion in a muted color, making line content stand out from metadata.

### Changed
- **Strip dead operations.** Removed leftover `append`, `prepend`, `replace_text` references from the hashline engine (already unsupported by the schema).
- **Refactored edit target resolution.** Extracted `resolveEditTarget()` so `computeEditPreview` and `execute` share the exact same access-check → kind-validation → BOM-strip → normalize → empty-file-guard pipeline.

## 0.8.0

### Breaking
- **Context-based hashing.** Each line's hash now incorporates its immediate neighbors (previous and next) instead of the line index. This means:
  - Distant edits no longer invalidate anchors (changing line 100 does not affect line 1's hash).
  - Nearby edits are correctly detected as stale (changing line 5 invalidates anchors on lines 4, 5, and 6).
  - The model must re-read after edits that touch lines near the target.
- **Removed textHint fuzzy matching.** Anchors no longer tolerate Unicode normalization mismatches via the copied text hint. If the hash doesn't match, the anchor is stale — period.

### Changed
- `computeLineHash(fileLines, index)` signature changed from `(lineNum, text)` to accept the full file lines array and a 0-based index.
- `formatHashlineRegion(fileLines, startLine, endLine)` now requires the full file context for correct hash computation.

## 0.7.4

- **Accept non-UTF-8 text files.** Legacy encodings (CP1251, ANSI, GBK) are no longer rejected as binary. Invalid bytes decode to U+FFFD, matching vanilla pi's built-in read tool. This prevents the model from falling back to raw `sed` edits that bypass hashline's anchor safety.
- **Warn on non-UTF-8 bytes in read.** If the decoded text contains U+FFFD, a warning is appended: `[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`. Detected on the full file, not just the visible slice, so out-of-view bad bytes still surface.
- **Package identifier in result details.** Both `read` and `edit` results now include `package: { name: "@jerryan/pi-hashline-edit", version: "0.7.4" }` in `details`, making it easy to identify hashline tool calls in session history. Join by `toolCallId` to link calls and results.

## 0.7.3

- **Content separator changed from `:` to `│` (U+2502).** The `│` character almost never appears in source code or documentation, making accidental inclusion in edit payloads far less likely.
- **Configurable separators.** `ANCHOR_SEP` (`#`) and `CONTENT_SEP` (`│`) are now exported constants from `hashline.ts`, making future changes trivial.
- **Validator catches `HH│` prefix bugs.** The `assertNoDisplayPrefixes` regex now detects `HH│` without requiring a full `LINE#HASH│` prefix, closing the gap where agents were including only the hash+separator.
- **Updated all prompts, docs, and tests** to use the new separator.

## 0.7.2

- **Unified diff output.** Agent and user see identical diff content generated from `structuredPatch` hunks.
- Format: ` NN#HH│context`, `-NN   │removed`, `+NN#HH│added` with aligned separators.
- Removed `--- Anchors ---` blocks; anchors are extracted directly from diff lines.
- Removed `computeAffectedLineRange`, `formatHashlineRegion`, anchor-block Markdown formatting.
- Removed `changed_lines` from metrics (no longer computed).
- **Stale anchor de-duplication.** Single-line range `[4#6B, 4#6B]` now reports "1 stale anchor" instead of "2 stale anchors: 4#6B, 4#6B".
- **Full-file deletion guardrail.** `[E_WOULD_EMPTY]` rejects edits that would delete the entire file, but only for files with more than 50 lines. Small files show the diff normally.

## 0.7.1

- Directory reads include the directory listing in the error, saving a follow-up `ls`.
- Clarify anchors can come from `--- Anchors ---` edit result blocks, not just `read`.
- Fix install command to scoped package name.
- Exclude profiling tests from vitest.

## 0.7.0

### Breaking
- **Single edit shape.** One entry type: `{ range: [start, end], lines: [...] }`. No `op`, `after`, `before`, `append`, `prepend`, `replace_text`.
- **Hex hash alphabet.** `0-9 A-F` replaces `ZPMQVRWSNKTXJBYH`.
- **Inline FNV-1a.** Replaces `xxhashjs` dependency. Always incorporates line index.
- **No legacy compatibility.** `{ oldText, newText }` substring replace format not accepted.
- **Dropped `returnMode`/`returnRanges`.** Only `changed` mode; response format is always anchors block.

### Added
- `read` `raw: true` mode — returns plain text without LINE#HASH anchors.
- `[E_BAD_RANGE]` for backwards `range` tuples.
- Symmetric boundary-duplication detection (both Variant A and B).

### Changed
- `@jerryan/pi-hashline-edit` package name (forked from RimuruW/pi-hashline-edit).
- Minimal prompt surface — removed return-format docs and error catalogues.
- Validation delegated to AJV; runtime guard only prevents crashes from missing required fields.

### Removed
- `op` field, `after`/`before` fields, `replace_text` op.
- `xxhashjs` and `@types/xxhashjs` dependencies.
- Legacy compatibility (`edit-compat.ts`, `compatibility-notify.ts`).
- `returnMode` options `full` and `ranges`.

## 0.6.1

Previous upstream release.
