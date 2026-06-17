/**
 * Hash-based anchor relocation.
 *
 * When anchors are stale against the live file, search ±OFFSET lines for
 * the anchor's hash. Both endpoints shift by the same offset. Only accepts
 * a single unique match; rejects on zero or multiple matches.
 *
 * No content comparison — purely hash-based.
 */
import {
  type HashlineFile,
  type HashlineEdit,
} from "./hashline";

const OFFSET_SINGLE = 1;
const OFFSET_MULTI = 2;

/**
 * Result shape shared by all matchers (exact, fuzzy, snapshot).
 */
export interface MatchResult {
  matched: HashlineEdit[];
  unmatched: HashlineEdit[];
  warnings: string[];
}

/**
 * Partition edits by hash validity against a file. Edits whose anchor hashes
 * match the file go into `matched`; the rest go into `unmatched`.
 */
export function partitionExact(
  edits: HashlineEdit[],
  file: HashlineFile,
): MatchResult {
  const matched: HashlineEdit[] = [];
  const unmatched: HashlineEdit[] = [];

  for (const edit of edits) {
    const refs = edit.end ? [edit.pos, edit.end] : [edit.pos];
    let ok = true;
    for (const ref of refs) {
      if (ref.line < 1 || ref.line > file.lines.length) {
        ok = false;
        break;
      }
      if (file.lineHashes[ref.line - 1] !== ref.hash) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matched.push(edit);
    } else {
      unmatched.push(edit);
    }
  }

  return { matched, unmatched, warnings: [] };
}

/**
 * Relocate stale edits by searching ±maxOffset lines in the live file for
 * the anchor's hash. Both endpoints shift by the same offset. Only accepts
 * a single unique match; rejects on zero or multiple matches.
 *
 * The anchor hash stays unchanged — we found it at the new position.
 */
export function fuzzyMatch(
  edits: HashlineEdit[],
  currentFile: HashlineFile,
): MatchResult {
  const matched: HashlineEdit[] = [];
  const unmatched: HashlineEdit[] = [];
  const warnings: string[] = [];
  let relocationCount = 0;

  for (const edit of edits) {
    const startLine = edit.pos.line;
    const endLine = edit.end?.line ?? startLine;

    const isSingle = edit.end === undefined || edit.end.line === edit.pos.line;
    const maxOffset = isSingle ? OFFSET_SINGLE : OFFSET_MULTI;

    // Search current file for the hash within ±maxOffset
    let bestOffset: number | null = null;

    for (let offset = -maxOffset; offset <= maxOffset; offset++) {
      const newStart = startLine + offset;
      const newEnd = endLine + offset;

      if (newStart < 1 || newEnd > currentFile.lines.length) continue;

      // Must match pos.hash at the new position
      if (currentFile.lineHashes[newStart - 1] !== edit.pos.hash) continue;

      // For range edits, end.hash must also match at the new position
      if (edit.end && currentFile.lineHashes[newEnd - 1] !== edit.end.hash) continue;

      if (bestOffset !== null) {
        // Multiple matches — reject
        bestOffset = null;
        break;
      }
      bestOffset = offset;
    }

    if (bestOffset === null) {
      unmatched.push(edit);
      continue;
    }

    // Relocate: shift both anchors by the offset, hash stays the same
    const newStart = startLine + bestOffset;
    const newEnd = endLine + bestOffset;

    const relocated: HashlineEdit = {
      op: edit.op,
      pos: {
        line: newStart,
        hash: edit.pos.hash,
      },
      end: edit.end
        ? {
            line: newEnd,
            hash: edit.end.hash,
          }
        : undefined,
      lines: edit.lines,
    };

    matched.push(relocated);
    relocationCount++;
  }

  if (relocationCount > 0) {
    warnings.push(
      `[RELOCATED] ${relocationCount} range(s) relocated via hash matching. Please review the diff carefully.`,
    );
  }

  return { matched, unmatched, warnings };
}
