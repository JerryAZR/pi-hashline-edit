import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
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
  ANCHOR_SEP,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { buildChangedResponse, buildNoopResponse } from "./edit-response";
import { setLastEdit } from "./undo";
import { partitionExact, fuzzyMatch } from "./fuzzy-match";
import { getReadSnapshot } from "./read-snapshot";
import { threeWayMerge } from "./merge";
import { formatDiffResult } from "./edit-diff-render";
import { resolveEditTarget } from "./edit";

// ─── Schema ─────────────────────────────────────────────────────────────

const insertEntrySchema = Type.Object(
  {
    anchor: Type.String({
      description:
        `LINE${ANCHOR_SEP}HASH anchor copied from a recent \`read\` output (e.g. "42${ANCHOR_SEP}A4"). The insert target.`,
    }),
    direction: Type.Enum({ after: "after", before: "before" }, {
      description: 'Insert direction: "after" or "before" the anchor line.',
    }),
    lines: Type.Array(Type.String(), {
      description: "Lines to insert.",
    }),
  },
  { additionalProperties: false },
);

export const insertToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    edits: Type.Array(insertEntrySchema, {
      description: "Insert operations to apply.",
    }),
  },
  { additionalProperties: false },
);

// ─── Types ──────────────────────────────────────────────────────────────

type InsertRequestParams = {
  path: string;
  edits: Record<string, unknown>[];
};

type InsertMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  classification: "applied" | "noop";
  added_lines?: number;
  removed_lines?: number;
};

type InsertToolDetails = {
  diff: string;
  warnings?: string[];
  snapshotId?: string;
  classification?: "noop";
  metrics?: InsertMetrics;
  package: { name: string; version: string };
};

const INSERT_DESC = readFileSync(
  new URL("../tool-descriptions/insert.md", import.meta.url),
  "utf-8",
).trim();

// ─── Normalization ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertInsertRequest(request: unknown): asserts request is InsertRequestParams {
  if (!isRecord(request)) {
    throw new Error("Insert request must be an object.");
  }
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('Insert request requires a non-empty "path" string.');
  }
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new Error('Insert request requires a non-empty "edits" array.');
  }
}

function normalizeInsertItems(edits: Record<string, unknown>[]): HashlineToolEdit[] {
  return edits.map((edit) => {
    const anchor = (edit.anchor as string) || "";
    const direction = (edit.direction as string) || "after";
    const op = direction === "before" ? "prepend" as const : "append" as const;
    return { op, pos: anchor, lines: (edit.lines as string[]) || [] };
  });
}

// ─── Render ─────────────────────────────────────────────────────────────

type EditPreview = { diff: string } | { error: string };
type InsertRenderState = {
  argsKey?: string;
  preview?: EditPreview;
  previewGeneration?: number;
};

function getRenderablePreviewInput(args: unknown): InsertRequestParams | null {
  if (!isRecord(args) || typeof args.path !== "string") {
    return null;
  }
  const request: InsertRequestParams = {
    path: args.path,
    edits: Array.isArray(args.edits) ? args.edits : [],
  };
  return request.edits.length > 0 ? request : null;
}

function formatInsertCall(
  args: InsertRequestParams | undefined,
  state: InsertRenderState,
  theme: {
    bold: (text: string) => string;
    fg: (token: string, text: string) => string;
  },
): string {
  const path = args?.path;
  const pathDisplay =
    typeof path === "string" && path.length > 0
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  let text = `${theme.fg("toolTitle", theme.bold("insert"))} ${pathDisplay}`;

  return text;
}

export async function computeInsertPreview(
  request: unknown,
  cwd: string,
): Promise<EditPreview> {
  try {
    assertInsertRequest(request);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const params = request as InsertRequestParams;
  const path = params.path;
  const absolutePath = resolveToCwd(path, cwd);
  const toolEdits = normalizeInsertItems(params.edits);

  const target = await resolveEditTarget(absolutePath, path, constants.R_OK);
  if (!target.ok) {
    return { error: target.error };
  }

  const lines: string[] = [];
  for (const edit of toolEdits) {
    const direction = edit.op === "prepend" ? "before" : "after";
    lines.push(`  insert ${direction} ${edit.pos}`);
  }

  return { diff: `Inserting ${toolEdits.length} block(s):\n${lines.join("\n")}` };
}

// ─── Tool definition ────────────────────────────────────────────────────

type InsertToolDefinition = ToolDefinition<
  typeof insertToolSchema,
  InsertToolDetails,
  InsertRenderState
> & { renderShell?: "default" | "self" };

const insertToolDefinition: InsertToolDefinition = {
  name: "insert",
  label: "Insert",
  description: INSERT_DESC,
  parameters: insertToolSchema,
  renderShell: "default",
  renderCall(args, theme, context) {
    const previewInput = getRenderablePreviewInput(args);
    if (context.executionStarted) {
      context.state.argsKey = undefined;
      context.state.preview = undefined;
      context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
    } else if (!context.argsComplete || !previewInput) {
      context.state.argsKey = undefined;
      context.state.preview = undefined;
      context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
    } else {
      const argsKey = JSON.stringify(previewInput);
      if (context.state.argsKey !== argsKey) {
        context.state.argsKey = argsKey;
        context.state.preview = undefined;
        const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
        context.state.previewGeneration = previewGeneration;
        computeInsertPreview(previewInput, context.cwd)
          .then((preview) => {
            if (
              context.state.argsKey === argsKey &&
              context.state.previewGeneration === previewGeneration
            ) {
              context.state.preview = preview;
              context.invalidate();
            }
          })
          .catch((err: unknown) => {
            if (
              context.state.argsKey === argsKey &&
              context.state.previewGeneration === previewGeneration
            ) {
              context.state.preview = {
                error: err instanceof Error ? err.message : String(err),
              };
              context.invalidate();
            }
          });
      }
    }
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(
      formatInsertCall(
        getRenderablePreviewInput(args) ?? undefined,
        context.state as InsertRenderState,
        theme as { bold: (text: string) => string; fg: (token: string, text: string) => string },
      ),
    );
    return text;
  },

  renderResult(result, { isPartial }, theme, context) {
    if (isPartial) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("warning", "Inserting..."));
      return text;
    }

    const typedResult = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: InsertToolDetails;
    };

    if (context.isError) {
      const textContent = typedResult.content?.find(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof entry.text === "string",
      );
      if (!textContent) return new Text("", 0, 0);
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      text.setText(`\n${theme.fg("error", textContent.text)}`);
      return text;
    }

    const details = typedResult.details;
    const metrics = details?.metrics;
    if (metrics?.classification === "applied" && details?.diff) {
      const maxLines = context.expanded ? Infinity : 16;
      const rendered = formatDiffResult(details.diff, maxLines, theme);

      const sections: string[] = [];
      if (rendered) sections.push(rendered);

      if (metrics.added_lines !== undefined || metrics.removed_lines !== undefined) {
        const parts: string[] = [];
        if (metrics.added_lines) parts.push(`${metrics.added_lines} insertion${metrics.added_lines !== 1 ? "s" : ""}(+)`);
        if (metrics.removed_lines) parts.push(`${metrics.removed_lines} removal${metrics.removed_lines !== 1 ? "s" : ""}(-)`);
        if (parts.length) sections.push(theme.fg("accent", parts.join(", ")));
      }
      if (details.warnings?.length) {
        sections.push(`Warnings:\n${details.warnings.join("\n")}`);
      }

      if (sections.length) {
        const text = context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
        text.setText(sections.join("\n\n"));
        return text;
      }
    }

    return new Text("", 0, 0);
  },

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    assertInsertRequest(params);

    const path = (params as InsertRequestParams).path;
    const absolutePath = resolveToCwd(path, ctx.cwd);
    const toolEdits = normalizeInsertItems(
      (params as InsertRequestParams).edits,
    );

    const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
    return withFileMutationQueue(mutationTargetPath, async () => {
      throwIfAborted(signal);
      const target = await resolveEditTarget(absolutePath, path, constants.R_OK | constants.W_OK);
      if (!target.ok) {
        const prefix = target.code ? `[${target.code}] ` : "";
        throw new Error(`${prefix}${target.error}`);
      }
      const { bom, normalized: originalNormalized, ending: originalEnding } = target;

      const resolved = resolveEditAnchors(toolEdits);

      let result: string;
      let warnings: string[];
      let noopEdits: { editIndex: number; loc: string; currentContent: string }[] | undefined;
      let merged = false;

      throwIfAborted(signal);
      const currentFile = buildHashlineFile(originalNormalized);
      const validation = validateAnchors(currentFile, resolved);

      if (!validation.ok) {
        if (validation.kind === "range") {
          throw new Error(validation.message);
        } else if (validation.kind === "stale") {
          // Multi-tier stale-anchor resolution
          const exactResult = partitionExact(resolved, currentFile);
          const snapshot = getReadSnapshot(absolutePath);
          let remaining = exactResult.unmatched;
          let allWarnings: string[] = [];
          let fuzzyEdits: HashlineEdit[] = [];

          // Tier 2: fuzzy match against current
          if (remaining.length > 0 && snapshot) {
            const fuzzyResult = fuzzyMatch(remaining, currentFile, snapshot.file);
            fuzzyEdits = fuzzyResult.matched;
            allWarnings.push(...fuzzyResult.warnings);
            remaining = fuzzyResult.unmatched;
          }

          // Fuzzy resolved all remaining
          if (remaining.length === 0) {
            const currentEdits = [...exactResult.matched, ...fuzzyEdits];
            const spanResult = resolveEditSpans(currentFile, currentEdits);
            if (!spanResult.ok) throw new Error(spanResult.message);
            const applied = applySpans(currentFile, spanResult.spans);
            result = applied.file.content;
            warnings = [...allWarnings, ...(spanResult.warnings ?? [])];
            noopEdits = spanResult.noopEdits;
            merged = true;
          }

          // Tier 3: snapshot match for any remaining edits
          if (!merged && snapshot && remaining.length > 0) {
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
                merged = true;
              }
            }
          }

          if (!merged) {
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
            throw new Error(formatMismatchError(mismatches, currentFile.lines, retryLines));
          }
        } else {
          throw new Error(`[E_INTERNAL] Unhandled validation kind: ${(validation as any).kind}`);
        }
      } else {
        const spanResult = resolveEditSpans(currentFile, resolved);
        if (!spanResult.ok) {
          throw new Error(spanResult.message);
        }
        const applied = applySpans(currentFile, spanResult.spans);
        result = applied.file.content;
        warnings = spanResult.warnings;
        noopEdits = spanResult.noopEdits;
      }

      const originalLineCount = originalNormalized.split("\n").length - (originalNormalized.endsWith("\n") ? 1 : 0);
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
      setLastEdit({ path, previousContent: originalNormalized });
      throwIfAborted(signal);
      await writeFileAtomically(
        absolutePath,
        bom + restoreLineEndings(result, originalEnding),
      );
      const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

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
  },
};

export function registerInsertTool(pi: ExtensionAPI): void {
  pi.registerTool(insertToolDefinition);
}
