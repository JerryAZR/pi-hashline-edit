import * as Diff from "diff";
import { CONTENT_SEP } from "./hashline";

export interface DiffTheme {
  fg: (token: string, text: string) => string;
  inverse: (text: string) => string;
}

interface ParsedLine {
  prefix: string;
  lineNum: string;
  /** Everything between lineNum and the content: "#HH│" or "   │" */
  meta: string;
  content: string;
}

function parseDiffLine(line: string): ParsedLine | null {
  const prefix = line[0];
  if (prefix !== "-" && prefix !== "+" && prefix !== " ") return null;
  if (line.startsWith("---") || line.startsWith("+++")) return null;

  const sepIdx = line.indexOf(CONTENT_SEP);
  if (sepIdx === -1) {
    // No content separator — treat whole line after prefix+lineNum as content
    const match = line.match(/^([+\- ])(\s*\d+)\s(.+)$/);
    if (!match) return null;
    const numEnd = line.indexOf(match[2]) + match[2].length;
    return {
      prefix: match[1],
      lineNum: match[2],
      meta: line.slice(3, numEnd), // spaces/padding between prefix+digits and content
      content: match[3],
    };
  }

  // Extract number from the metadata portion
  // Extract the full padded line number from the metadata portion
  const metaFull = line.slice(1, sepIdx); // e.g. " 9#AB" or "12   "
  const digitsMatch = metaFull.match(/\d+/);
  if (!digitsMatch) return null;

  // lineNum includes left-padding so column alignment is preserved
  const digits = digitsMatch[0];
  const digitsStart = metaFull.indexOf(digits);
  const lineNum = metaFull.slice(0, digitsStart + digits.length); // " 9" or "12"
  const meta = metaFull.slice(lineNum.length) + CONTENT_SEP; // "#AB│" or "   │"
  const content = line.slice(sepIdx + CONTENT_SEP.length);

  return { prefix, lineNum, meta, content };
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses Diff.diffWords which groups whitespace with adjacent words.
 * Strips leading whitespace from first changed part to avoid highlighting indentation.
 *
 * Ratio guard: skips intra-line diffing if > CHANGED_RATIO_THRESHOLD of tokens
 * are changed (i.e. the line is essentially rewritten), falling back to flat
 * foreground coloring.
 */
const CHANGED_RATIO_THRESHOLD = 0.5;

function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  theme: DiffTheme,
): { removedLine: string; addedLine: string } | null {
  const wordDiff = Diff.diffWords(oldContent, newContent);

  // Count changed vs total tokens for the ratio guard
  let changedTokens = 0;
  let totalTokens = 0;
  for (const part of wordDiff) {
    if (part.removed || part.added) {
      changedTokens++;
    }
    totalTokens++;
  }

  // If more than half the tokens changed, don't bother with intra-line diffs
  if (totalTokens > 0 && changedTokens / totalTokens > CHANGED_RATIO_THRESHOLD) {
    return null;
  }

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) {
        removedLine += theme.inverse(value);
      }
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) {
        addedLine += theme.inverse(value);
      }
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Render a hashline-formatted diff string with colored lines and intra-line
 * change highlighting.
 *
 * - Context lines: dim
 * - Removed lines: error (red), with inverse on changed tokens (1:1 pairs only)
 * - Added lines: success (green), with inverse on changed tokens (1:1 pairs only)
 * - Multi-line block changes: flat foreground color, no token highlighting
 */
export function renderDiff(diffText: string, theme: DiffTheme): string[] {
  const lines = diffText.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseDiffLine(line);

    if (!parsed) {
      result.push(theme.fg("dim", line));
      i++;
      continue;
    }

    if (parsed.prefix === "-") {
      // Collect consecutive removed lines
      const removedLines: ParsedLine[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "-") break;
        removedLines.push(p);
        i++;
      }

      // Collect consecutive added lines
      const addedLines: ParsedLine[] = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "+") break;
        addedLines.push(p);
        i++;
      }

      // Intra-line diff only for 1:1 line modification pairs
      if (removedLines.length === 1 && addedLines.length === 1) {
        const removed = removedLines[0]!;
        const added = addedLines[0]!;

        const intraResult = renderIntraLineDiff(
          removed.content.replace(/\t/g, "   "),
          added.content.replace(/\t/g, "   "),
          theme,
        );

        if (intraResult) {
          result.push(
            theme.fg(
              "error",
              `-${removed.lineNum}${removed.meta}${intraResult.removedLine}`,
            ),
          );
          result.push(
            theme.fg(
              "success",
              `+${added.lineNum}${added.meta}${intraResult.addedLine}`,
            ),
          );
        } else {
          // Ratio guard kicked in — flat coloring
          result.push(
            theme.fg(
              "error",
              `-${removed.lineNum}${removed.meta}${removed.content}`,
            ),
          );
          result.push(
            theme.fg(
              "success",
              `+${added.lineNum}${added.meta}${added.content}`,
            ),
          );
        }
      } else {
        // Multi-line block — flat foreground
        for (const removed of removedLines) {
          result.push(
            theme.fg(
              "error",
              `-${removed.lineNum}${removed.meta}${removed.content}`,
            ),
          );
        }
        for (const added of addedLines) {
          result.push(
            theme.fg(
              "success",
              `+${added.lineNum}${added.meta}${added.content}`,
            ),
          );
        }
      }
    } else if (parsed.prefix === "+") {
      // Standalone added line (no preceding removal)
      result.push(
        theme.fg(
          "success",
          `+${parsed.lineNum}${parsed.meta}${parsed.content}`,
        ),
      );
      i++;
    } else {
      // Context line
      result.push(
        theme.fg(
          "dim",
          ` ${parsed.lineNum}${parsed.meta}${parsed.content}`,
        ),
      );
      i++;
    }
  }

  return result;
}

/**
 * Legacy-compatible wrapper: render a diff string through renderDiff and return
 * an array of colored lines. Useful as a drop-in replacement for the old
 * prefix-only colorDiffLines.
 */
export function colorDiffLines(
  lines: string[],
  theme: DiffTheme,
): string[] {
  const joined = lines.join("\n");
  return renderDiff(joined, theme);
}
