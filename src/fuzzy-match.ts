/**
 * Exact anchor partitioning.
 *
 * Splits edits by hash validity against a file. Edits whose anchor hashes
 * match the file go into `matched`; the rest go into `unmatched`.
 *
 * Used by the mutation engine (exact match) and by the snapshot-merge fallback.
 */
import {
  type HashlineFile,
  type HashlineEdit,
} from "./hashline";

/**
 * Result shape shared by exact and snapshot matchers.
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

