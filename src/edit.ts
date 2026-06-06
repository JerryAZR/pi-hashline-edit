import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
  applyHashlineEdits,
  resolveEditAnchors,
  type HashlineToolEdit,
  ANCHOR_SEP,
  CONTENT_SEP,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";

import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { buildChangedResponse, buildNoopResponse } from "./edit-response";
import { setLastEdit } from "./undo";

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

type EditTargetResult =
  | { ok: false; error: string; code?: string }
  | {
      ok: true;
      normalized: string;
      bom: string;
      ending: "\r\n" | "\n";
    };

async function resolveEditTarget(
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

function colorDiffLines(
  lines: string[],
  theme: { fg: (token: string, text: string) => string },
): string[] {
  return lines.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return theme.fg("success", line);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return theme.fg("error", line);
    }
    return theme.fg("dim", line);
  });
}
function formatPreviewDiff(
  diff: string,
  expanded: boolean,
  theme: { fg: (token: string, text: string) => string },
): string {
  const lines = diff.split("\n");
  const maxLines = expanded ? 40 : 16;
  const shown = colorDiffLines(lines.slice(0, maxLines), theme);

  if (lines.length > maxLines) {
    shown.push(theme.fg("muted", `... ${lines.length - maxLines} more diff lines`));
  }
  return shown.join("\n");
}

function formatResultDiff(
  diff: string,
  theme: { fg: (token: string, text: string) => string },
): string {
  return colorDiffLines(diff.split("\n"), theme).join("\n");
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
  text: string | undefined,
  details: HashlineEditToolDetails | undefined,
  preview: EditPreview | undefined,
  theme: { fg: (token: string, text: string) => string },
): string | undefined {
  const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
  const sections: string[] = [];

  if (details?.diff && details.diff !== previewDiff) {
    sections.push(formatResultDiff(details.diff, theme));
  }

  const warnings = text?.match(/(?:^|\n\n)Warnings:\n[\s\S]*$/)?.[0]?.trimStart();
  if (warnings) sections.push(warnings);

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
  const originalNormalized = target.normalized;

  try {
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(originalNormalized, resolved).content;

    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edits produced identical content.`,
      };
    }

    return { diff: generateDiffString(originalNormalized, result).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
        renderedText,
        typedResult.details,
        previewBeforeResult,
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


      const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);
      const result = anchorResult.content;
      const warnings = anchorResult.warnings;
      const originalLineCount = originalNormalized.split("\n").length - (originalNormalized.endsWith("\n") ? 1 : 0);
      if (result.length === 0 && originalLineCount > 50) {
        throw new Error(
          "[E_WOULD_EMPTY] This edit would delete the entire file. The edit tool does not allow full-file deletion for files with more than 50 lines. If you truly intend to clear the file, use the write tool to overwrite it with an empty string.",
        );
      }
      const noopEdits = anchorResult.noopEdits;
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
