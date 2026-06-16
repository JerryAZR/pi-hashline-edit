import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
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
  CONTENT_SEP,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { buildChangedResponse, buildNoopResponse } from "./edit-response";
import { setLastEdit } from "./undo";
import { getReadSnapshot } from "./read-snapshot";
import { threeWayMerge } from "./merge";
import { partitionExact, fuzzyMatch } from "./fuzzy-match";
import { colorDiffLines, formatDiffResult } from "./edit-diff-render";

const editEntrySchema = Type.Object(
  {
    range: Type.Tuple([Type.String(), Type.String()], {
      description:
        `LINE${ANCHOR_SEP}HASH anchor pair [start, end] copied from a recent \`read\` or diff output. Use the same anchor twice for single-line: ["42${ANCHOR_SEP}A4", "42${ANCHOR_SEP}A4"].`,
    }),
    lines: Type.Array(Type.String(), {
      description: "New content lines. Use [] to delete.",
    }),
  },
  { additionalProperties: false },
);
export const hashlineEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    edits: Type.Array(editEntrySchema, {
      description: `Edits to apply to $path. Each edit replaces the range [start, end] with lines. Use the same anchor twice for single-line; use [] to delete.`,
    }),
  },
  { additionalProperties: false },
);


type EditRequestParams = {
  path: string;
  edits: Record<string, unknown>[];
};

type EditMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  classification: "applied" | "noop";
  added_lines?: number;
  removed_lines?: number;
};

type HashlineEditToolDetails = {
  diff: string;
  warnings?: string[];
  snapshotId?: string;
  classification?: "noop";
  metrics?: EditMetrics;
  package: { name: string; version: string };
};

const EDIT_DESC = readFileSync(
  new URL("../tool-descriptions/edit.md", import.meta.url),
  "utf-8",
).trim();

const EDIT_PROMPT_SNIPPET = readFileSync(
  new URL("../tool-descriptions/edit-snippet.md", import.meta.url),
  "utf-8",
).trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Safety net for environments where AJV validation is disabled.
// Field-type and schema validation are AJV's responsibility;
// only prevent crashes from missing required top-level fields.
// Path existence is checked in execute() once CWD is available.
export function assertEditRequest(request: unknown): asserts request is EditRequestParams {
  if (!isRecord(request)) {
    throw new Error("Edit request must be an object.");
  }
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new Error('Edit request requires a non-empty "edits" array.');
  }
}

export function normalizeEditItems(edits: Record<string, unknown>[]): HashlineToolEdit[] {
  return edits.map((edit) => {
    const [pos, end] = (edit.range as [string, string]) || ["", ""];
    return { op: "replace", pos, end, lines: (edit.lines as string[]) || [] };
  });
}

export type EditTargetResult =
  | { ok: false; error: string; code?: string }
  | {
      ok: true;
      normalized: string;
      bom: string;
      ending: "\r\n" | "\n";
    };

export async function resolveEditTarget(
  absolutePath: string,
  path: string,
  accessMode: number,
): Promise<EditTargetResult> {
  try {
    await fsAccess(absolutePath, accessMode);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `File not found: ${path}` };
    }
    if (code === "EACCES" || code === "EPERM") {
      const action = accessMode & constants.W_OK ? "writable" : "readable";
      return { ok: false, error: `File is not ${action}: ${path}` };
    }
    return { ok: false, error: `Cannot access file: ${path}` };
  }

  const file = await loadFileKindAndText(absolutePath);
  if (file.kind === "directory") {
    return {
      ok: false,
      error: `Path is a directory: ${path}. Use ls to inspect directories.`,
    };
  }
  if (file.kind === "image") {
    return {
      ok: false,
      error: `Path is an image file: ${path}. Hashline edit only supports text files.`,
    };
  }
  if (file.kind === "binary") {
    return {
      ok: false,
      error: `Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`,
    };
  }

  const { bom, text: content } = stripBom(file.text);
  const normalized = normalizeToLF(content);
  if (normalized.length === 0) {
    return {
      ok: false,
      code: "E_EMPTY_FILE",
      error: `File is empty: ${path}. The edit tool requires anchors from a read output, which an empty file cannot provide. Use the write tool to create initial content in an empty file.`,
    };
  }

  return {
    ok: true,
    normalized,
    bom,
    ending: detectLineEnding(content),
  };
}


type EditPreview = { diff: string } | { error: string };
type EditRenderState = {
  argsKey?: string;
  preview?: EditPreview;
  previewGeneration?: number;
};

function getRenderablePreviewInput(args: unknown): EditRequestParams | null {
  if (!isRecord(args) || typeof args.path !== "string") {
    return null;
  }

  const request: EditRequestParams = {
    path: args.path,
    edits: Array.isArray(args.edits) ? args.edits : [],
  };
  return request.edits.length > 0 ? request : null;
}

function formatPreviewDiff(
  diff: string,
  expanded: boolean,
  theme: { fg: (token: string, text: string) => string },
): string {
  return formatDiffResult(diff, expanded ? 40 : 16, theme);
}

function getRenderedEditTextContent(
  result: { content?: Array<{ type: string; text?: string }> },
): string | undefined {
  const textContent = result.content?.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  return textContent?.text;
}

function isAppliedChangedResult(
  details: HashlineEditToolDetails | undefined,
): boolean {
  const metrics = details?.metrics;
  return (
    metrics?.classification === "applied" &&
    metrics.added_lines !== undefined &&
    metrics.removed_lines !== undefined
  );
}

function buildAppliedChangedResultText(
  details: HashlineEditToolDetails | undefined,
  preview: EditPreview | undefined,
  expanded: boolean,
  theme: { fg: (token: string, text: string) => string },
): string | undefined {
  const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
  const sections: string[] = [];

  if (details?.diff && details.diff !== previewDiff) {
    const maxLines = expanded ? Infinity : 16;
    const rendered = formatDiffResult(details.diff, maxLines, theme);
    if (rendered) sections.push(rendered);
  }

  if (details?.metrics?.added_lines !== undefined) {
    const added = details.metrics.added_lines ?? 0;
    const removed = details.metrics.removed_lines ?? 0;
    const parts: string[] = [];
    if (added) parts.push(`${added} insertion${added !== 1 ? "s" : ""}(+)`);
    if (removed) parts.push(`${removed} deletion${removed !== 1 ? "s" : ""}(-)`);
    if (parts.length) {
      sections.push(theme.fg("accent", parts.join(", ")));
    }
  }

  if (details?.warnings?.length) {
    sections.push(`Warnings:\n${details.warnings.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function formatEditCall(
  args: EditRequestParams | undefined,
  state: EditRenderState,
  expanded: boolean,
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
  let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

  if (!state.preview) {
    return text;
  }

  if ("error" in state.preview) {
    text += `\n\n${theme.fg("error", state.preview.error)}`;
    return text;
  }

  if (state.preview.diff) {
    text += `\n\n${formatPreviewDiff(state.preview.diff, expanded, theme)}`;
  }
  return text;
}

export async function computeEditPreview(
  request: unknown,
  cwd: string,
): Promise<EditPreview> {
  try {
    assertEditRequest(request);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const params = request as EditRequestParams;
  const path = params.path;
  const absolutePath = resolveToCwd(path, cwd);
  const toolEdits = normalizeEditItems(params.edits);

  const target = await resolveEditTarget(absolutePath, path, constants.R_OK);
  if (!target.ok) {
    return { error: target.error };
  }

  const lines: string[] = [];
  for (const edit of toolEdits) {
    const end = edit.end ?? edit.pos;
    lines.push(`  ${edit.pos} → ${end}`);
  }

  return { diff: `Editing ${toolEdits.length} block(s):\n${lines.join("\n")}` };
}

type EditToolDefinition = ToolDefinition<
  typeof hashlineEditToolSchema,
  HashlineEditToolDetails,
  EditRenderState
> & { renderShell?: "default" | "self" };

const editToolDefinition: EditToolDefinition = {
  name: "edit",
  label: "Edit",
  description: EDIT_DESC,
  parameters: hashlineEditToolSchema,
  promptSnippet: EDIT_PROMPT_SNIPPET,
  // Force the default tool shell (Box with pending/success/error background) so
  // we don't inherit renderShell: "self" from the built-in edit tool of the
  // same name, which would drop the shared background color block.
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
        computeEditPreview(previewInput, context.cwd)
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
      formatEditCall(
        getRenderablePreviewInput(args) ?? undefined,
        context.state as EditRenderState,
        context.expanded,
        theme,
      ),
    );
    return text;
  },

  renderResult(result, { isPartial }, theme, context) {
    if (isPartial) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("warning", "Editing..."));
      return text;
    }

    const typedResult = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: HashlineEditToolDetails;
    };
    const renderedText = getRenderedEditTextContent(typedResult);

    const renderState = context.state as EditRenderState | undefined;
    const previewBeforeResult = renderState?.preview;
    if (renderState) {
      renderState.preview = undefined;
      renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
    }

    if (context.isError) {
      if (!renderedText) {
        return new Text("", 0, 0);
      }
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      text.setText(`\n${theme.fg("error", renderedText)}`);
      return text;
    }

    if (isAppliedChangedResult(typedResult.details)) {
      const appliedChangedText = buildAppliedChangedResultText(
        typedResult.details,
        previewBeforeResult,
        context.expanded,
        theme,
      );
      if (!appliedChangedText) {
        return new Text("", 0, 0);
      }
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      text.setText(appliedChangedText);
      return text;
    }

    if (!renderedText) {
      return new Text("", 0, 0);
    }

    const text = context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
    text.setText(renderedText);
    return text;
  },

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    assertEditRequest(params);

    const path = (params as EditRequestParams).path;
    const absolutePath = resolveToCwd(path, ctx.cwd);
    const toolEdits = normalizeEditItems(
      (params as EditRequestParams).edits,
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

          // Tier 2: fuzzy match against current (needs snapshot for content comparison)
          if (remaining.length > 0 && snapshot) {
            const fuzzyResult = fuzzyMatch(remaining, currentFile, snapshot.file);
            fuzzyEdits = fuzzyResult.matched;
            allWarnings.push(...fuzzyResult.warnings);
            remaining = fuzzyResult.unmatched;
          }

          // Fuzzy resolved all remaining — apply exact + fuzzy to current (no merge)
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
          // Exhaustiveness: if validateAnchors adds a new error kind, fail loud
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

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool(editToolDefinition);
}
