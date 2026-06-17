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
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { buildChangedResponse } from "./edit-response";
import { PACKAGE_INFO } from "./package-info";
import { colorDiffLines } from "./edit-diff-render";

const UNDO_DESC = readFileSync(
  new URL("../tool-descriptions/undo.md", import.meta.url),
  "utf-8",
).trim();

const MAX_UNDO_TURNS = 3;

type Snapshot = {
  path: string;
  content: string;
  turnIndex: number;
};

let lastSnapshot: Snapshot | undefined;
let currentTurnIndex = 0;

// ─── Tool definition ────────────────────────────────────────────────────

const undoToolSchema = Type.Object({}, { additionalProperties: false });

type UndoToolDetails = {
  diff: string;
  snapshotId?: string;
  package: { name: string; version: string };
};


const undoToolDefinition: ToolDefinition<
  typeof undoToolSchema,
  UndoToolDetails
> & { renderShell?: "default" | "self" } = {
  name: "undo",
  label: "Undo",
  description: UNDO_DESC,
  parameters: undoToolSchema,
  renderShell: "default",

  renderCall(_args, theme, _context) {
    return new Text(
      `${theme.fg("toolTitle", "undo")} ${theme.fg("toolOutput", "revert last edit")}`,
      0, 0,
    );
  },

  renderResult(result, { isPartial }, theme, _context) {
    if (isPartial) return new Text(theme.fg("warning", "Undoing..."), 0, 0);
    const typedResult = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: UndoToolDetails;
    };
    if (typedResult.details?.diff) {
      const text = colorDiffLines(
        typedResult.details.diff.split("\n"),
        theme,
      ).join("\n");
      return new Text(text, 0, 0);
    }
    const renderedText = typedResult.content?.find(
      (entry): entry is { type: "text"; text: string } =>
        entry.type === "text" && typeof entry.text === "string",
    )?.text;
    if (renderedText) return new Text(theme.fg("error", renderedText), 0, 0);
    return new Text("", 0, 0);
  },

  async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
    const entry = lastSnapshot;
    if (!entry) {
      throw new Error(
        "[E_NO_UNDO] No edit to undo. The undo tool only reverts the most recent hashline edit in this session.",
      );
    }

    const turnsSinceEdit = currentTurnIndex - entry.turnIndex;
    if (turnsSinceEdit > MAX_UNDO_TURNS) {
      throw new Error(
        `[E_NO_UNDO] The last edit was ${turnsSinceEdit} turns ago. Undo is only available for edits within the last ${MAX_UNDO_TURNS} turns.`,
      );
    }

    const path = entry.path;
    const absolutePath = resolveToCwd(path, ctx.cwd);
    const mutationTargetPath = await resolveMutationTargetPath(absolutePath);

    return withFileMutationQueue(mutationTargetPath, async () => {
      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`File not found: ${path}`);
        if (code === "EACCES" || code === "EPERM") throw new Error(`File is not writable: ${path}`);
        throw new Error(`Cannot access file: ${path}`);
      }

      throwIfAborted(signal);
      const file = await loadFileKindAndText(absolutePath);
      if (file.kind !== "text") {
        throw new Error(`Hashline undo only supports text files. ${path} is ${file.kind}.`);
      }

      throwIfAborted(signal);
      const { bom, text: currentText } = stripBom(file.text);
      const originalEnding = detectLineEnding(currentText);
      const currentNormalized = normalizeToLF(currentText);
      const restoredContent = entry.content;

      if (currentNormalized === restoredContent) {
        return {
          content: [{ type: "text", text: "No changes needed. File already matches the pre-edit state." }],
          details: { diff: "", package: PACKAGE_INFO },
        };
      }

      throwIfAborted(signal);
      await writeFileAtomically(
        absolutePath,
        bom + restoreLineEndings(restoredContent, originalEnding),
      );

      lastSnapshot = undefined;
      const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
      const { diff } = generateDiffString(currentNormalized, restoredContent);

      return buildChangedResponse({
        path,
        originalNormalized: currentNormalized,
        result: restoredContent,
        warnings: [],
        snapshotId: updatedSnapshotId,
        editsAttempted: 1,
        noopEditsCount: 0,
      });
    });
  },
};

// ─── Test helpers ────────────────────────────────────────────────────────

/** Set the last undo snapshot directly. For testing only. */
export function _setLastSnapshot(path: string, content: string, turnIndex?: number): void {
  lastSnapshot = { path, content: normalizeToLF(content), turnIndex: turnIndex ?? currentTurnIndex };
}

/** Override the current turn index. For testing only. */
export function _setCurrentTurn(index: number): void {
  currentTurnIndex = index;
}

/** Clear all undo state. For testing only. */
export function _resetUndo(): void {
  lastSnapshot = undefined;
  currentTurnIndex = 0;
}

// ─── Registration ───────────────────────────────────────────────────────

export function registerUndoTool(pi: ExtensionAPI): void {
  pi.registerTool(undoToolDefinition);

  pi.on("turn_start", async (event) => {
    currentTurnIndex = event.turnIndex;
  });

  pi.events.on("hashline:edit-applied", (data: { path: string; absolutePath: string; beforeContent: string }) => {
    lastSnapshot = {
      path: data.path,
      content: data.beforeContent,
      turnIndex: currentTurnIndex,
    };
  });
}
