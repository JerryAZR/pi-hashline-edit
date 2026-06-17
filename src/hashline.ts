/**
 * Hashline engine — hash-anchored line editing.
 *
 * Originally vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 * Hash algorithm: inline FNV-1a with surrounding-line context.
 */

// --- Types ---

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit = {
  op: "replace" | "append" | "prepend";
  pos: Anchor;
  end?: Anchor;
  lines: string[];
};

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

export interface NoopEdit {
  editIndex: number;
  loc: string;
  currentContent: string;
}

export interface HashlineFile {
  readonly lines: readonly string[];
  readonly lineHashes: readonly string[];
  readonly lineStarts: readonly number[];
  readonly content: string;
}

// --- Hash computation ---

const HEX = "0123456789ABCDEF";
const HASH_ALPHABET_RE = /^[0-9A-F]+$/;

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${HEX[h]}${HEX[l]}`;
});

export const ANCHOR_SEP = "#";
export const CONTENT_SEP = "│";

// FNV-1a 32-bit constants
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function normalizeLine(line: string): string {
  return line.replace(/\r/g, "").trimEnd();
}

/**
 * FNV-1a hash of prev + "\0" + curr + "\0" + next.
 * All three strings must already be normalized (no \r, trailing whitespace trimmed).
 */
function fnvHash(prev: string, curr: string, next: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < prev.length; i++) {
    hash = Math.imul(hash ^ prev.charCodeAt(i), FNV_PRIME);
  }
  hash = Math.imul(hash ^ 0, FNV_PRIME); // \0 delimiter
  for (let i = 0; i < curr.length; i++) {
    hash = Math.imul(hash ^ curr.charCodeAt(i), FNV_PRIME);
  }
  hash = Math.imul(hash ^ 0, FNV_PRIME); // \0 delimiter
  for (let i = 0; i < next.length; i++) {
    hash = Math.imul(hash ^ next.charCodeAt(i), FNV_PRIME);
  }
  return DICT[hash & 0xff];
}

/**
 * Compute a context hash for line at `index` (0-based) within `fileLines`.
 * The hash incorporates the line itself plus its immediate neighbors
 * (previous and next), so distant edits do not invalidate anchors.
 * Missing neighbors (file boundaries) contribute an empty string.
 */
export function computeLineHash(fileLines: readonly string[], index: number): string {
  const prev = index > 0 ? normalizeLine(fileLines[index - 1]!) : "";
  const curr = normalizeLine(fileLines[index]!);
  const next = index < fileLines.length - 1 ? normalizeLine(fileLines[index + 1]!) : "";
  return fnvHash(prev, curr, next);
}

/**
 * Compute a context hash from already-normalized strings.
 * For callers that have pre-processed line text (e.g. from ripgrep output).
 * Calls the same underlying FNV-1a as computeLineHash.
 */
export function computeHashFromContext(prev: string, curr: string, next: string): string {
  return fnvHash(prev, curr, next);
}

export function buildHashlineFile(content: string): HashlineFile {
  const lines = content.length === 0
    ? []
    : content.endsWith("\n")
      ? content.split("\n").slice(0, -1)
      : content.split("\n");

  const lineHashes = lines.map((_, i) => computeLineHash(lines, i));

  const lineStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset);
    offset += lines[i]!.length;
    if (i < lines.length - 1) offset += 1;
  }

  return { lines, lineHashes, lineStarts, content };
}

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(?:\\d+\\s*${ANCHOR_SEP}\\s*|${ANCHOR_SEP}\\s*)?[0-9A-F]{2}${CONTENT_SEP}`);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
  `^\\+\\s*(?:\\d+\\s*${ANCHOR_SEP}\\s*|${ANCHOR_SEP}\\s*)?[0-9A-F]{2}${CONTENT_SEP}`);
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
  const trimmed = ref.trim();
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

  if (!core.length) {
    return `[E_BAD_REF] Invalid line reference "${ref}". Expected "LINE${ANCHOR_SEP}HASH" (e.g. "5${ANCHOR_SEP}MQ").`;
  }
  if (/^\d+\s*$/.test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash, use "LINE${ANCHOR_SEP}HASH" from read output (e.g. "5${ANCHOR_SEP}MQ").`;
  }
  if (new RegExp(`^\d+\s*[:${CONTENT_SEP}]`).test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": wrong separator, use "LINE${ANCHOR_SEP}HASH" instead of "LINE:..." or "LINE${CONTENT_SEP}...".`;
  }

  const hashMatch = core.match(new RegExp(`^(\d+)\s*${ANCHOR_SEP}\s*([^\s${CONTENT_SEP}]+)(?:\s*${CONTENT_SEP}.*)?$`));
  if (hashMatch) {
    const line = Number.parseInt(hashMatch[1]!, 10);
    const hash = hashMatch[2]!;
    if (line < 1) {
      return `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`;
    }
    if (hash.length !== 2) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly 2 characters from 0-9 A-F.`;
    }
    if (!HASH_ALPHABET_RE.test(hash)) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet 0-9 A-F only.`;
    }
  }

  const missingHashMatch = core.match(new RegExp(`^(\d+)\s*${ANCHOR_SEP}\s*$`));
  if (missingHashMatch) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash after "${ANCHOR_SEP}", use "LINE${ANCHOR_SEP}HASH" from read output.`;
  }

  if (new RegExp(`^0+\s*${ANCHOR_SEP}`).test(core)) {
    return `[E_BAD_REF] Line number must be >= 1, got 0 in "${ref}".`;
  }

  return `[E_BAD_REF] Invalid line reference "${trimmed || ref}". Expected "LINE${ANCHOR_SEP}HASH" (e.g. "5${ANCHOR_SEP}MQ").`;
}


function parseAnchorRef(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(new RegExp(`^([0-9]+)\\s*${ANCHOR_SEP}\\s*([^\\s${CONTENT_SEP}]+)(?:\\s*${CONTENT_SEP}(.*))?$`, "s"));
  if (!match) {
    throw new Error(diagnoseLineRef(ref));
  }

  const line = Number.parseInt(match[1]!, 10);
  if (line < 1) {
    throw new Error(`[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`);
  }

  const hash = match[2]!;
  if (hash.length !== 2) {
    throw new Error(`[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly 2 characters from 0-9 A-F.`);
  }

  if (!HASH_ALPHABET_RE.test(hash)) {
    throw new Error(
      `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet 0-9 A-F only.`,
    );
  }

  const textHint = match[3];
  return {
    line,
    hash,
    ...(textHint !== undefined ? { textHint } : {}),
  };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

export function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: readonly string[],
  retryLines: ReadonlySet<number> = new Set<number>(),
): string {
  const retryLineSet = new Set<number>(retryLines);
  for (const m of mismatches) {
    retryLineSet.add(m.line);
  }

  // De-duplicate: same line + same expected hash = same anchor
  const seenKeys = new Set<string>();
  const uniqueMismatches = mismatches.filter((m) => {
    const key = `${m.line}:${m.expected}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const displayLines = new Set<number>();
  for (const m of uniqueMismatches) {
    for (
      let i = Math.max(1, m.line - 2);
      i <= Math.min(fileLines.length, m.line + 2);
      i++
    ) {
      displayLines.add(i);
    }
  }
  for (const line of retryLineSet) {
    displayLines.add(line);
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  const maxDisplayLine = sorted[sorted.length - 1] ?? 1;
  const lineNumberWidth = String(maxDisplayLine).length;
  const anchorList = uniqueMismatches.map((m) => `${m.line}${ANCHOR_SEP}${m.expected}`).join(", ");
  const out: string[] = [
    `[E_STALE_ANCHOR] ${uniqueMismatches.length} stale anchor${uniqueMismatches.length > 1 ? "s" : ""}: ${anchorList}. Retry with the >>> LINE${ANCHOR_SEP}HASH lines below; keep both endpoints for range replaces.`,
    "",
  ];

  let prev = -1;
  for (const num of sorted) {
    if (prev !== -1 && num > prev + 1) out.push("    ...");
    prev = num;
    const content = fileLines[num - 1];
    const hash = computeLineHash(fileLines, num - 1);
    const prefix = `${String(num).padStart(lineNumberWidth, " ")}${ANCHOR_SEP}${hash}`;
    out.push(
      retryLineSet.has(num)
        ? `>>> ${prefix}${CONTENT_SEP}${content}`
        : `    ${prefix}${CONTENT_SEP}${content}`,
    );
  }

  return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

/**
 * Reject hashline display prefixes in edit payloads. Strict semantics: the
 * model must send literal file content for `lines`, not the rendered read /
 * diff form. Silent stripping is no longer performed — see AGENTS.md.
 */
function assertNoDisplayPrefixes(lines: string[]): void {
  for (const line of lines) {
    if (!line.length) continue;
    if (
      HASHLINE_PREFIX_RE.test(line) ||
      HASHLINE_PREFIX_PLUS_RE.test(line) ||
      DIFF_MINUS_RE.test(line)
    ) {
      throw new Error(
        `[E_INVALID_PATCH] "lines" must contain literal file content, not rendered "LINE${ANCHOR_SEP}HASH${CONTENT_SEP}" or diff "+/-" prefixes. Offending line: ${JSON.stringify(line)}`,
      );
    }
  }
}

/**
 * Parse replacement text into lines.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim so
 * explicitly provided blank lines remain intact. Display prefixes are
 * rejected by `assertNoDisplayPrefixes`, never silently stripped.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  const lines = typeof edit === "string"
    ? (edit.endsWith("\n") ? edit.slice(0, -1) : edit).replaceAll("\r", "").split("\n")
    : edit;
  assertNoDisplayPrefixes(lines);
  return lines;
}

/**
 * Map flat tool-schema edits into typed internal representations.
 *
 * Strict: provided anchors must parse successfully.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  return edits.map((edit) => ({
    op: edit.op,
    pos: parseAnchorRef(edit.pos),
    ...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
    lines: hashlineParseText(edit.lines ?? null),
  }));
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines may be string|null). */
export type HashlineToolEdit = {
  op: "replace" | "append" | "prepend";
  pos: string;
  end?: string;
  lines?: string[] | string | null;
};

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
  edits: HashlineEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
      );
    }
  }
}

function describeEdit(edit: HashlineEdit): string {
  return edit.end
    ? `replace ${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}-${edit.end.line}${ANCHOR_SEP}${edit.end.hash}`
    : `replace ${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}`;
}

export type AnchorValidation =
  | { ok: true }
  | { ok: false; message: string };

export function validateAnchors(
  file: HashlineFile,
  edits: HashlineEdit[],
) : AnchorValidation {
  for (const edit of edits) {
    if (edit.end && edit.pos.line > edit.end.line) {
      return {
        ok: false,
        message: `[E_BAD_RANGE] Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`,
      };
    }

    const refs = edit.end ? [edit.pos, edit.end] : [edit.pos];
    for (const ref of refs) {
      if (ref.line < 1 || ref.line > file.lines.length) {
        return {
          ok: false,
          message: `[E_RANGE_OOB] Line ${ref.line} does not exist (file has ${file.lines.length} lines)`,
        };
      }
    }
  }
  return { ok: true };
}

export type EditSpan = {
  index: number;
  label: string;
  start: number;
  end: number;
  replacement: string;
  op: "replace" | "append" | "prepend";
};

export type SpanResolution =
  | { ok: true; spans: EditSpan[]; noopEdits: NoopEdit[]; warnings: string[] }
  | { ok: false; code: string; message: string };

export function resolveEditSpans(
  file: HashlineFile,
  edits: HashlineEdit[],
): SpanResolution {
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  maybeWarnSuspiciousUnicodeEscapePlaceholder(edits, warnings);

  const seenSpanKeys = new Set<string>();
  const spans: EditSpan[] = [];

  for (const [index, edit] of edits.entries()) {
    const startLine = edit.pos.line;
    const endLine = edit.end?.line ?? edit.pos.line;
    const originalLines = file.lines.slice(startLine - 1, endLine);

    // Append/prepend: insert pure content, no deletion
    if (edit.op === "append") {
      let start: number;
      if (edit.pos.line < file.lines.length) {
        start = file.lineStarts[edit.pos.line]!; // right after anchor line's \n
      } else {
        start = file.content.length;
      }
      const replacement = edit.pos.line < file.lines.length
        ? edit.lines.join("\n") + "\n"
        : (file.content.endsWith("\n") ? "" : "\n") + edit.lines.join("\n");
      spans.push({
        index,
        label: describeEdit(edit),
        start,
        end: start,
        replacement,
        op: "append",
      });
      continue;
    }

    if (edit.op === "prepend") {
      const start = file.lineStarts[edit.pos.line - 1]!;
      const replacement = edit.lines.join("\n") + "\n";
      spans.push({
        index,
        label: describeEdit(edit),
        start,
        end: start,
        replacement,
        op: "prepend",
      });
      continue;
    }

    // Noop detection
    if (
      originalLines.length === edit.lines.length &&
      originalLines.every((line, i) => line === edit.lines[i])
    ) {
      noopEdits.push({
        editIndex: index,
        loc: `${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}`,
        currentContent: originalLines.join("\n"),
      });
      continue;
    }

    // Boundary duplication warning
    const checkBoundary = (candidate: string | undefined, boundary: string | undefined, label: string) => {
      if (!candidate || !boundary) return;
      const c = candidate.trim();
      const b = boundary.trim();
      if (c && /[\p{L}\p{N}]/u.test(c) && c === b) {
        warnings.push(
          `Potential boundary duplication ${label} ${describeEdit(edit)}: the replacement ${label === "after" ? "ends" : "starts"} with a line that matches the ${label === "after" ? "next surviving" : "preceding"} line after trim.`,
        );
      }
    };
    checkBoundary(edit.lines.at(-1), file.lines[endLine], "after");
    if (startLine > 1) checkBoundary(edit.lines[0], file.lines[startLine - 2], "before");

    // Resolve to span
    let span: EditSpan;
    if (edit.lines.length > 0) {
      span = {
        index,
        label: describeEdit(edit),
        start: file.lineStarts[startLine - 1]!,
        end: file.lineStarts[endLine - 1]! + file.lines[endLine - 1]!.length,
        replacement: edit.lines.join("\n"),
        op: "replace",
      };
    } else if (startLine === 1 && endLine === file.lines.length) {
      span = {
        index,
        label: describeEdit(edit),
        start: 0,
        end: file.content.length,
        replacement: "",
        op: "replace",
      };
    } else if (endLine < file.lines.length) {
      span = {
        index,
        label: describeEdit(edit),
        start: file.lineStarts[startLine - 1]!,
        end: file.lineStarts[endLine]!,
        replacement: "",
        op: "replace",
      };
    } else {
      span = {
        index,
        label: describeEdit(edit),
        start: Math.max(0, file.lineStarts[startLine - 1]! - 1),
        end: file.lineStarts[endLine - 1]! + file.lines[endLine - 1]!.length,
        replacement: "",
        op: "replace",
      };
    }

    const spanKey = `replace:${span.start}:${span.end}:${span.replacement}`;
    if (seenSpanKeys.has(spanKey)) continue;
    seenSpanKeys.add(spanKey);
    spans.push(span);
  }

  // Check for overlapping spans
  for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
    const left = spans[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < spans.length; rightIndex++) {
      const right = spans[rightIndex]!;
      if (left.start < right.end && right.start < left.end) {
        return {
          ok: false,
          code: "E_EDIT_CONFLICT",
          message: `[E_EDIT_CONFLICT] Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) overlap on the same original line range. Merge them into one non-overlapping change or split the request.`,
        };
      }
    }
  }

  return { ok: true, spans, noopEdits, warnings };
}

export function applySpans(
  file: HashlineFile,
  spans: EditSpan[],
): { file: HashlineFile; firstChangedLine: number | undefined; lastChangedLine: number | undefined } {
  const orderedSpans = [...spans].sort((left, right) => {
    if (right.end !== left.end) return right.end - left.end;
    return left.index - right.index;
  });

  let result = file.content;
  for (const span of orderedSpans) {
    result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
  }

  const changedRange = computeChangedLineRange(file.content, result);
  return {
    file: buildHashlineFile(result),
    firstChangedLine: changedRange?.firstChangedLine,
    lastChangedLine: changedRange?.lastChangedLine,
  };
}


export function formatHashlineRegion(
  fileLines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const lineNumberWidth = String(endLine).length;
  return fileLines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const lineNumber = startLine + index;
      const paddedLineNumber = String(lineNumber).padStart(lineNumberWidth, " ");
      return `${paddedLineNumber}${ANCHOR_SEP}${computeLineHash(fileLines, startLine - 1 + index)}${CONTENT_SEP}${line}`;
    })
    .join("\n");
}

// ─── Edit line range computation ────────────────────────────────────────

/**
 * Compute first/last changed line numbers from the edit result.
 * Uses character-level diff to locate the changed span, then maps to line
 * numbers in the result document so downstream anchor chaining works.
 */
function computeChangedLineRange(
  original: string,
  result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
  if (original === result) return null;

  function countVisibleLines(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    const lines = text.split("\n");
    return text.endsWith("\n") ? lines.length - 1 : lines.length;
  }

  if (original.length === 0) {
    return {
      firstChangedLine: 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  if (result.startsWith(original) && original.endsWith("\n")) {
    return {
      firstChangedLine: countVisibleLines(original) + 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  let firstDiff = 0;
  const minLen = Math.min(original.length, result.length);
  while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
    firstDiff++;
  }
  if (firstDiff === minLen && original.length === result.length) return null;

  let lastOrig = original.length - 1;
  let lastRes = result.length - 1;
  while (
    lastOrig >= firstDiff &&
    lastRes >= firstDiff &&
    original[lastOrig] === result[lastRes]
  ) {
    lastOrig--;
    lastRes--;
  }

  function indexToLine(charIdx: number, text: string): number {
    let line = 1;
    for (let i = 0; i < charIdx && i < text.length; i++) {
      if (text[i] === "\n") line++;
    }
    return line;
  }

  const firstChangedLine = indexToLine(firstDiff + 1, result);
  let lastChangedLine: number;
  if (lastRes < firstDiff) {
    lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
  } else if (firstDiff === 0 && original.length > 0 && result.endsWith(original)) {
    lastChangedLine = firstChangedLine;
  } else {
    lastChangedLine = indexToLine(lastRes + 1, result);
  }

  return { firstChangedLine, lastChangedLine };
}
