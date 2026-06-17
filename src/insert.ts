import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import {
  type HashlineToolEdit,
  ANCHOR_SEP,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { formatDiffResult } from "./edit-diff-render";
import { setReadSnapshot } from "./read-snapshot";
import { resolveEditTarget } from "./edit";
import { applyMutation } from "./mutation";
import { isRecord } from "./runtime";

const insertEntrySchema = Type.Object(
  {
    anchor: Type.String({
      description:
        `LINE${ANCHOR_SEP}HASH anchor copied from a recent \`read\` output (e.g. "42${ANCHOR_SEP}A4"). The insert target.`,
    }),
    direction: Type.String({
      enum: ["after", "before"],
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

    return applyMutation({
      pi: _insertPi,
      path,
      absolutePath,
      toolEdits,
      signal,
      ctx,
    });
  },
};

let _insertPi: ExtensionAPI | undefined;

export function registerInsertTool(pi: ExtensionAPI): void {
  _insertPi = pi;
  pi.events.on("hashline:read-snapshot", (data: { path: string; file: import("./hashline").HashlineFile }) => {
    setReadSnapshot(data.path, data.file);
  });
  pi.registerTool(insertToolDefinition);
}
