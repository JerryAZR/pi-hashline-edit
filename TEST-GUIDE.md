# Agent-Driven Edit Tool Test

Create a temporary test file and verify the edit tool's behavior end-to-end. Read the tool output carefully — anchors change after each edit.

**Do not use bash except where explicitly instructed.** All file modifications throughout these tests must go through the `edit` tool unless a scenario specifically tells you to use bash.

---

## Setup

Create `test-file.ts` with this content:

```
import { thing } from "./lib";

function hello() {
  console.log("hello");
}

// filler line 1
// filler line 2
// filler line 3
// filler line 4
// filler line 5
// filler line 6
// filler line 7
// filler line 8
// filler line 9
// filler line 10
// filler line 11
// filler line 12
// filler line 13
// filler line 14
// filler line 15
// filler line 16
// filler line 17
// filler line 18
// filler line 19
// filler line 20
// filler line 21
// filler line 22
// filler line 23
// filler line 24
// filler line 25
// filler line 26
// filler line 27
// filler line 28
// filler line 29
// filler line 30
// filler line 31
// filler line 32
// filler line 33
// filler line 34
// filler line 35
// filler line 36
// filler line 37
// filler line 38
// filler line 39
// filler line 40
// filler line 41
// filler line 42
// filler line 43
// filler line 44
// filler line 45
// filler line 46
// filler line 47
// filler line 48

function goodbye() {
  console.log("goodbye");
  console.log("see ya");
}

export { hello, goodbye };
```

---

## Happy Path

### 1. Change one line

Read `test-file.ts`. Find the anchor for `  console.log("hello");` and replace that one line with `  console.log("hi");`.
Afterward, the file should contain `hi` instead of `hello` on that line, and nothing else should have changed.

### 2. Replace several lines

Read `test-file.ts`. Target the two inner lines of the `goodbye` function — `console.log("goodbye");` and `console.log("see ya");` — and replace them with:

```
  console.log("farewell");
  console.log("adios");
```

Afterward, the `goodbye` function should contain these two new lines and its closing `}` should still be intact.

### 3. Delete lines

Remove the blank line and the `export` line at the bottom of the file, in one edit.
Afterward, the file should end right after the closing `}` of the `goodbye` function.

### 4. Diff view on a successful edit

Make any successful edit. Verify the response text shows a unified diff with:
- Context lines in the form ` NN#HH│content`
- Removed lines in the form `-NN   │content` (no hash)
- Added lines in the form `+NN#HH│content`

The `│` separators should be vertically aligned. The diff should show only the changed region plus a few lines of surrounding context.

### 5. Multiple non-overlapping edits in one request

Reset `test-file.ts` to the original content. In a single edit request with two entries:
- Change `console.log("hello");` to `console.log("hi");`
- Change `console.log("goodbye");` to `console.log("ciao");`

Both changes should apply. The diff output should contain **two separate hunks** separated by `    ...`. Verify the file contains both `hi` and `ciao` after the edit.

---

## Error Handling

### 6. Stale anchor (content changed nearby)

Read `test-file.ts`. Then use the bash tool to change the line **right before** `console.log("hello");` — for example, change `function hello() {` to `function helloWorld() {`.

Now attempt an edit on `console.log("hello");` using the anchors from your earlier read.

Expected: `[E_STALE_ANCHOR]`. The error includes current anchors for the affected lines. Copy them and retry — the retry should succeed.

### 7. Backwards range

Attempt an edit where the range endpoint anchor comes from an earlier line than the start anchor.
Expected: `[E_BAD_RANGE]` with an explanation.

### 8. Missing fields

Send an edit request with no `path`, or with `edits` omitted.
Expected: a clear error, not a crash.

### 9. LINE#HASH prefix in lines

Read `test-file.ts`, then send an edit where `lines` contains content copied directly from the read output — with `LINE#HASH│` prefixes.
Expected: `[E_INVALID_PATCH]`. The model must strip the prefixes before sending.

### 10. Rendered output in lines

Read `test-file.ts`, then send an edit where `lines` contains content copied directly from the read or diff output — with `LINE#HASH│` prefixes, `+12#A4│` diff-added hashline lines, or `-12    old` diff-context headers.
Expected: `[E_INVALID_PATCH]`. The model must strip display prefixes before sending.

### 11. Overlapping ranges

Send two edits in one request whose ranges overlap. For example, one targeting lines 2–5 and another targeting 4–7.
Expected: rejected with an error about overlapping or conflicting ranges.

### 12. Read a directory

Try reading a directory path instead of a file.
Expected: the error shows the directory listing, so you can pick a file directly without running `ls`.

### 13. Full-file deletion guardrail

Attempt to delete the entire contents of `test-file.ts` in one edit (replace all lines with `[]`).
Expected: `[E_WOULD_EMPTY]` because the file has more than 50 lines. The tool rejects catastrophic full-file deletions for large files.

---

## Advanced Features

### 14. Undo the last edit

Make any successful edit to `test-file.ts`. Then call the `undo` tool with no arguments.
Expected: The file is restored to its pre-edit state. The response contains a diff of what was reverted.

### 15. Undo consumed after use

Call `undo` a second time immediately after Test 14.
Expected: `[E_NO_UNDO]` — the undo slot is consumed after the first successful revert.

### 16. 3-way merge fallback (deep shift)

Read `test-file.ts` and note the anchor for `console.log("see ya");`. Use the bash tool to insert **three lines** at the very top of the file (e.g., `// header1`, `// header2`, `// header3`). This shifts all line numbers down by three — beyond the ±1 fuzzy window.

Now attempt an edit on `console.log("see ya");` using the **old anchors**.

Expected: The edit succeeds with a `[MERGED]` warning. The file contains both your edit change AND the prepended headers. The tool detected stale anchors, fuzzy matching couldn't relocate (shift exceeds ±1), fell back to the snapshot, and applied via 3-way merge.


### 17. Raw read has no anchors

Read `test-file.ts` with `raw: true`. Confirm the returned text contains no `LINE#HASH│` prefixes — it should be plain file content.

### 18. Non-UTF-8 file

Use the bash tool to create `binary-ish.txt` with a mix of valid UTF-8 and a non-UTF-8 byte sequence. For example:
```bash
echo -e "hello\n\xff\xfeworld" > binary-ish.txt
```

Read `binary-ish.txt`.
Expected: The read succeeds. The output contains a warning about non-UTF-8 bytes shown as U+FFFD. You can still edit the file — the edit tool will rewrite it as valid UTF-8.

---

## Edge Cases

### 19. Insert at start of file

Add new content before the existing first line. For example, prepend a `// Copyright ...` comment.
The original line 1 should still be in the file, just pushed down.

### 20. Insert at end of file

Add new content after the last line. For example, append a blank line and a trailing comment.
The original last line should still be in the file, directly before the new content.

### 21. Multi-element lines array

Edit a range, placing at least three distinct lines into the `lines` array (not one string with `\n`).
Afterward, all three lines should appear in the file as separate lines.

### 22. Delete one line

Pick any line and remove it from the file in a single edit. Do not replace it with a blank line — the line should be gone.

---

## Grep Tool

### 23. Basic search with anchors

Search `test-file.ts` for `console.log`. Verify the results contain `LINE#HASH│` anchors. The anchors should match the same file's `read` output — check that the hash for one of the matched lines matches what `read` produces for the same line.

### 24. Grep with context lines

Search `test-file.ts` for `goodbye` with `context: 1`. Verify you see the matching line plus one line before and one line after — all with hashline anchors. The line before and after should NOT extend beyond the context boundary.

### 25. Grep then edit

Search `test-file.ts` for `console.log("goodbye")`. Copy one of the `LINE#HASH` anchors directly from the grep output and use it in an `edit` call to change `goodbye` to `farewell`. Do NOT `read` the file first. The edit should succeed with valid anchors from grep.


## Cleanup

Delete `test-file.ts` and `binary-ish.txt` when done.
