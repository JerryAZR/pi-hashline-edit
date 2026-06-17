# Changelog

## 0.11.3

### Fixed
- **Moonshot AI compatibility.** Replaced `Type.Enum({ after, before })` with `Type.String({ enum: ["after", "before"] })` in the insert tool schema. TypeBox's `anyOf`+`const` output is rejected by Moonshot's JSON schema validator.

## 0.11.2

### Changed
- **Fuzzy match is hash-based.** No more content comparison or snapshot dependency. Searches ±1 line (single) or ±2 lines (range) for the anchor's hash. Both endpoints of a range must shift together. Rejects on zero or multiple matches.
- **`validateAnchors` is structural-only.** Checks range order and line bounds; hash validation is exclusively in the 3-tier recovery flow (`partitionExact` → fuzzy → merge). No redundant path.
- **Single mutation path.** The old happy-path `else` branch (for all-valid anchors) is eliminated. All edits flow through the same `partitionExact` → fuzzy → merge flow — perfect anchors become a zero-unmatched pass-through.
- **Shared mutation engine.** `src/mutation.ts` — `edit` and `insert` are now ~12-line adapters calling `applyMutation()` with their normalized edits. The 60-line duplicate mutation logic is gone.
- **Unified cross-extension events.** `undo` and `insert` both consume `pi.events` for cross-extension data (undo snapshots, read snapshots). No lifecycle hook duplication, no session file bloat.

### Fixed
- **Hash-line confusion in fuzzy match.** Anchor `3#A4` (hash of `gamma = 3`, wrong line) previously matched `alpha = 1` via content-based fuzzy. Now correctly rejected — hash doesn't match at that position.


## 0.11.0

### Added
- **Grep tool.** Overrides the built-in `grep` with hashline-backed output. Spawns ripgrep with `--context` to get surrounding lines from JSON events, then formats results with `LINE#HASH│` anchors so agents can grep → edit without an intermediate read. No file reads needed — all content comes from ripgrep's JSON output. Respects `.gitignore` by default. Only registers if ripgrep is available (checks pi's bin directory then system PATH).
- **Insert tool.** `{ anchor, direction: "after"|"before", lines }` inserts new content between existing lines without touching them. The anchor line is preserved — no need to repeat its content.
- **Append/prepend internal ops.** The hashline engine now supports `"append"` and `"prepend"` alongside `"replace"`. `resolveEditSpans` computes zero-width insertion spans; `applySpans` handles all three identically. External schemas diverge (edit = range, insert = anchor+direction) but the internal data path converges to the same span-based pipeline.
- **Intra-line diff highlighting (opt-in).** `src/edit-diff-render.ts` exports `renderDiff()` which uses `Diff.diffWords` and `theme.inverse()` to highlight changed tokens within 1:1 line-modification pairs. A 50% ratio guard skips full-line rewrites to avoid inverse-everything noise. Not called by the default rendering path — available for opt-in enhancement.
- **Shared `formatDiffResult()`.** Both `edit` and `insert` result cards render diffs through a single function: truncation, coloring, and "... N more diff lines" notice.

### Changed

- **Edit prompt emphasizes replacement.** Snippet and description now lead with "Replace content" rather than "Edit/Patch". Line 1 states "existing content is removed; only the new lines remain".
- **Simplified insert tool card.** Removed per-edit anchor details from the render call; matches the edit card's path-only style.
- **Line number alignment preserved.** `parseDiffLine` now carries the full padded line number (e.g. `" 9"` not `"9"`) so single- and multi-digit line numbers align in diff output.
- **Renderer unified.** Removed duplicate diff rendering from `insert.ts`; both tools share `colorDiffLines` and `formatDiffResult` from `edit-diff-render.ts`.
- **`hashline.ts` refactor for grep.** Extracted `fnvHash` (single source of truth for FNV-1a), exported `computeHashFromContext(prev, curr, next)` for callers with pre-normalized strings, and exported `normalizeLine` for consistent line normalization across tools.

### Fixed
- **CI installs ripgrep.** `sudo apt-get install ripgrep` added to test workflow so grep tool tests run on ubuntu-latest. Register test made conditional on rg availability.
- **Insert description clarification.** Last paragraph now states the anchor line is preserved and warns against accidentally repeating its content.

## 0.10.1

### Changed
- **Compact/expanded diff in result card.** The edit result now truncates the diff to 16 lines in compact mode and shows the full diff when expanded.
- **Change summary line.** Shows `22 insertions(+), 1 deletion(-)` between the diff and warnings.


## 0.10.0

### Added
- **Fuzzy anchor relocation.** When anchors are stale but the original content still exists at a nearby position, the fuzzy matcher searches ±1 line for single-line edits and ±2 lines for multi-line ranges. Both endpoints shift together. Only a single unique match is accepted; zero or multiple matches skip to the next tier.
- **`partitionExact(edits, file)`** — splits edits by hash validity against a file. Shared by all three matcher tiers.
- **`fuzzyMatch(edits, currentFile, snapshotFile)`** — content-based relocation using the snapshot as ground truth. Relocated anchors receive fresh hashes computed from the current file's context.

### Changed
- **Multi-tier stale-anchor resolution.** The `edit` tool now tries three tiers in order: exact match on the live file, fuzzy relocation on the live file, snapshot match + 3-way merge. Edits are split across tiers within a single batch. Any unresolved edits reject the entire request.
- **Single-line fuzzy offset reduced to ±1.** Shorter search window for single-line edits avoids accidental relocation to a semantically different but textually identical line.


## 0.9.0

### Changed
- **Split hashline engine into `HashlineFile` + composable phases.** Replaced the monolithic `applyHashlineEdits(content, edits)` with three focused functions:
  - `buildHashlineFile(content)` — one-time preprocessing: splits lines, computes context hashes, builds byte-offset index.
  - `validateAnchors(file, edits)` — checks ranges, OOB, and hash mismatches. Returns a discriminated union (`{ ok: true } | { ok: false, kind: "range" } | { ok: false, kind: "stale" }`).
  - `resolveEditSpans(file, edits)` — noop detection, boundary-duplication warnings, span resolution, overlap detection.
  - `applySpans(file, spans)` — pure application: sorts spans bottom-up, slices content, returns a new `HashlineFile`.
- **Explicit control flow in merge fallback.** The `edit` tool's execute path no longer uses exception-driven branching (`try { apply } catch { if message.includes("[E_STALE_ANCHOR]") ... }`). It calls `validateAnchors` directly and handles each outcome explicitly.
- **`read-snapshot.ts`** — New single-slot in-memory snapshot store. Stores the most recent non-raw `read` as a `HashlineFile` (pre-computed lines, hashes, and byte offsets). When anchors are stale against the live file, the 3-way merge fallback validates against this snapshot and rebases the edit patch.
- **Path-resolved snapshot keys.** Snapshots are keyed by absolute path, so a `read` with a relative path and an `edit` with an absolute path still match.
- **Warnings passed through `details`.** `details.warnings` is now a structured string array. The TUI render path consumes it directly instead of regex-parsing the flat `text` output back out.

### Added
- **`src/merge.ts`** — `threeWayMerge(base, baseEdited, current)` using `diff.structuredPatch` with `fuzzFactor: 0`. Called when anchors are stale against the live file but valid against the snapshot.
- **Exhaustive validation handling.** `edit.ts` uses `if/else if/else` over `validateAnchors` outcomes. An unhandled kind throws `[E_INTERNAL]` to fail loud if new error types are added later.
### Changed
- **Lightweight preview.** `computeEditPreview` no longer runs the full edit engine or generates diffs. It returns a human summary like `Editing 2 block(s):\n  5#AB → 8#CD`.
- **Noop edits tracked in `resolveEditSpans`.** Previously tracked inside `applyHashlineEdits` during span resolution. Now part of the `SpanResolution` result.


## 0.8.3

### Changed
- **Prompt cleanups.** Removed "session switches, reloads, or restarts" from undo prompt (agent has no concept of sessions). Removed "shift" from the edit anchor rule — shifting anchors is not forbidden, just not encouraged.

## 0.8.2

### Reverted
- **Dimmed anchors in diff output.** Reverted the v0.8.1 change that split diff lines at `│` and rendered the anchor/hash in a separate color. The visual break was choppy and drew attention to metadata that should not be highlighted. Diff lines are now colored monolithically by prefix (`+` success, `-` error, ` ` dim) as before.

## 0.8.1

### Added
- **Undo tool.** Reverts the most recent hashline edit within the last 3 conversation turns. Useful when the model realizes an edit was wrong before the context window scrolls away.
- **[E_EMPTY_FILE] guard.** Rejects edits on empty files with a clear error directing the model to the write tool.
- **Dimmed anchors in diff output.** Diff rendering splits each line at `│` and renders the anchor/hash portion in a muted color, making line content stand out from metadata.

### Changed
- **Strip dead operations.** Removed leftover `append`, `prepend`, and `replace_text` references from the hashline engine (already unsupported by the schema).
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
