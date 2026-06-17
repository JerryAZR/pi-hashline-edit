import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { constants } from "fs";
import {
  restoreLineEndings,
} from "./edit-diff";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
  buildHashlineFile,
  validateAnchors,
  resolveEditSpans,
  applySpans,
  resolveEditAnchors,
  type HashlineToolEdit,
  type HashlineEdit,
  formatMismatchError,
} from "./hashline";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { buildChangedResponse, buildNoopResponse } from "./edit-response";
import { partitionExact, fuzzyMatch } from "./fuzzy-match";
import { getReadSnapshot } from "./read-snapshot";
import { threeWayMerge } from "./merge";
import { resolveEditTarget, emitUndoSnapshot } from "./edit";

// ─── Types ─────────────────────────────────────────────────────────────────

export type MutationResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: any;
};

export type MutationOptions = {
  pi: ExtensionAPI | undefined;
  path: string;
  absolutePath: string;
  toolEdits: HashlineToolEdit[];
  signal: AbortSignal;
  ctx: ExtensionContext;
};

// ─── Shared mutation engine ────────────────────────────────────────────────

/**
 * Apply a set of hashline edits to a file.
 *
 * Handles everything from queue acquisition and file resolution through
 * stale-anchor recovery, span application, atomic write, snapshot recording,
 * and undo-emission.  Returns the same shape as buildChangedResponse /
 * buildNoopResponse.
 */
export async function applyMutation(options: MutationOptions): Promise<MutationResult> {
  const { pi, path, absolutePath, toolEdits, signal, ctx } = options;

  const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
  return withFileMutationQueue(mutationTargetPath, async () => {
    throwIfAborted(signal);
    const target = await resolveEditTarget(
      absolutePath,
      path,
      constants.R_OK | constants.W_OK,
    );
    if (!target.ok) {
      const prefix = target.code ? `[${target.code}] ` : "";
      throw new Error(`${prefix}${target.error}`);
    }
    const { bom, normalized: originalNormalized, ending: originalEnding } = target;

    const resolved = resolveEditAnchors(toolEdits);

    let result: string;
    let warnings: string[];
    let noopEdits:
      | { editIndex: number; loc: string; currentContent: string }[]
      | undefined;

    throwIfAborted(signal);
    const currentFile = buildHashlineFile(originalNormalized);

    // Structural validation (range, line bounds)
    const struct = validateAnchors(currentFile, resolved);
    if (!struct.ok) throw new Error(struct.message);

    // Tier 1: exact hash match
    const exactResult = partitionExact(resolved, currentFile);
    const snapshot = getReadSnapshot(absolutePath);
    let allWarnings: string[] = [];
    let fuzzyEdits: HashlineEdit[] = [];
    let remaining = exactResult.unmatched;

    // Tier 2: hash-based fuzzy — search +-N lines for anchor hash
    if (remaining.length > 0) {
      const fuzzyResult = fuzzyMatch(remaining, currentFile);
      fuzzyEdits = fuzzyResult.matched;
      allWarnings.push(...fuzzyResult.warnings);
      remaining = fuzzyResult.unmatched;
    }

    let resolved_ = remaining.length === 0;

    // Apply exact + fuzzy to current file
    if (resolved_) {
      const currentEdits = [...exactResult.matched, ...fuzzyEdits];
      const spanResult = resolveEditSpans(currentFile, currentEdits);
      if (!spanResult.ok) throw new Error(spanResult.message);
      const applied = applySpans(currentFile, spanResult.spans);
      result = applied.file.content;
      warnings = [...allWarnings, ...(spanResult.warnings ?? [])];
      noopEdits = spanResult.noopEdits;
    }

    // Tier 3: snapshot match → 3-way merge
    if (!resolved_ && snapshot && remaining.length > 0) {
      const snapResult = partitionExact(remaining, snapshot.file);
      if (snapResult.unmatched.length === 0) {
        const currentEdits = [...exactResult.matched, ...fuzzyEdits];
        const snapshotEdits = snapResult.matched;

        const currentSpans = resolveEditSpans(currentFile, currentEdits);
        if (!currentSpans.ok) throw new Error(currentSpans.message);

        const snapSpans = resolveEditSpans(snapshot.file, snapshotEdits);
        if (!snapSpans.ok) throw new Error(snapSpans.message);

        allWarnings.push(
          "[MERGED] File changed since last read. Edits were rebased onto the current version. Please review the diff carefully.",
        );

        const currentApplied = applySpans(currentFile, currentSpans.spans);
        const snapApplied = applySpans(snapshot.file, snapSpans.spans);

        const mergedContent = threeWayMerge(
          snapshot.file.content,
          snapApplied.file.content,
          currentApplied.file.content,
        );

        if (mergedContent !== null) {
          result = mergedContent;
          warnings = [
            ...allWarnings,
            ...(currentSpans.warnings ?? []),
            ...(snapSpans.warnings ?? []),
          ];
          noopEdits = [
            ...(currentSpans.noopEdits ?? []),
            ...(snapSpans.noopEdits ?? []),
          ];
          resolved_ = true;
        }
      }
    }

    if (!resolved_) {
      const retryLines = new Set<number>();
      const mismatches = remaining.flatMap((e) => {
        const refs = e.end ? [e.pos, e.end] : [e.pos];
        return refs.map((r) => {
          retryLines.add(r.line);
          return {
            line: r.line,
            expected: r.hash,
            actual: currentFile.lineHashes[r.line - 1] ?? "OOB",
          };
        });
      });
      throw new Error(
        formatMismatchError(mismatches, currentFile.lines, retryLines),
      );
    }

    const originalLineCount =
      originalNormalized.split("\n").length -
      (originalNormalized.endsWith("\n") ? 1 : 0);
    if (result.length === 0 && originalLineCount > 50) {
      throw new Error(
        "[E_WOULD_EMPTY] This edit would delete the entire file. The edit tool does not allow full-file deletion for files with more than 50 lines. If you truly intend to clear the file, use the write tool to overwrite it with an empty string.",
      );
    }
    const editsAttempted = toolEdits.length;

    if (originalNormalized === result) {
      const noopSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
      return buildNoopResponse({
        path,
        noopEdits,
        originalNormalized,
        snapshotId: noopSnapshotId,
        editsAttempted,
        warnings,
      });
    }
    throwIfAborted(signal);
    await writeFileAtomically(
      absolutePath,
      bom + restoreLineEndings(result, originalEnding),
    );
    const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

    emitUndoSnapshot(pi, path, absolutePath, originalNormalized);

    return buildChangedResponse({
      path,
      originalNormalized,
      result,
      warnings,
      snapshotId: updatedSnapshotId,
      editsAttempted,
      noopEditsCount: noopEdits?.length ?? 0,
    });
  });
}
