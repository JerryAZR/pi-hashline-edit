import * as Diff from "diff";
import { computeLineHash, ANCHOR_SEP, CONTENT_SEP } from "./hashline";

// ─── Line ending normalization ──────────────────────────────────────────

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ─── Diff generation ────────────────────────────────────────────────────

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string } {
  const patch = Diff.structuredPatch("a", "b", oldContent, newContent, undefined, undefined, {
    context: contextLines,
  });

  if (!patch.hunks.length) {
    return { diff: "" };
  }

  const maxLineNum = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length,
  );
  const lineNumWidth = String(maxLineNum).length;
  const hashPad = " ".repeat(ANCHOR_SEP.length + 2); // align with `${ANCHOR_SEP}HH${CONTENT_SEP}`
  const output: string[] = [];

  // Build context array for hash computation (same normalization as getPreviewLines)
  const newFileLines = newContent.length === 0
    ? []
    : newContent.endsWith("\n")
      ? newContent.split("\n").slice(0, -1)
      : newContent.split("\n");

  for (let h = 0; h < patch.hunks.length; h++) {
    const hunk = patch.hunks[h]!;
    if (h > 0) {
      output.push("    ...");
    }

    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;

      const prefix = line[0] as " " | "+" | "-";
      const text = line.slice(1);

      if (prefix === "-") {
        const padded = String(oldLineNum).padStart(lineNumWidth, " ");
        output.push(`-${padded}${hashPad}${CONTENT_SEP}${text}`);
        oldLineNum++;
      } else if (prefix === "+") {
        const padded = String(newLineNum).padStart(lineNumWidth, " ");
        const hash = computeLineHash(newFileLines, newLineNum - 1);
        output.push(`+${padded}${ANCHOR_SEP}${hash}${CONTENT_SEP}${text}`);
        newLineNum++;
      } else {
        const padded = String(newLineNum).padStart(lineNumWidth, " ");
        const hash = computeLineHash(newFileLines, newLineNum - 1);
        output.push(` ${padded}${ANCHOR_SEP}${hash}${CONTENT_SEP}${text}`);
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  return { diff: output.join("\n") };
}


type DiffPreviewKind = "context" | "addition" | "deletion";

function classifyDiffPreviewLine(line: string): DiffPreviewKind | null {
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith(" ")) return "context";
  return null;
}

function summarizeOmitted(count: number, label: string): string {
  return `... ${count} more ${label} line${count === 1 ? "" : "s"}`;
}

function collapseDiffPreviewRun(
  lines: string[],
  maxVisible: number,
  label: string,
): string[] {
  if (lines.length <= maxVisible) {
    return lines;
  }

  return [
    ...lines.slice(0, maxVisible),
    summarizeOmitted(lines.length - maxVisible, label),
  ];
}

