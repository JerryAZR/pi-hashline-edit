

/**
 * Simple prefix-based diff coloring. Each line gets a flat foreground color
 * based on its + / - / space prefix. No intra-line token highlighting.
 */
export function colorDiffLines(
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

/**
 * Format a diff string for display: color lines, truncate to maxLines,
 * append a "... N more diff lines" notice if truncated.
 * Shared between edit and insert tool result rendering.
 */
export function formatDiffResult(
  diffText: string,
  maxLines: number,
  theme: { fg: (token: string, text: string) => string },
): string {
  const allLines = diffText.split("\n");
  if (allLines.length === 0) return "";
  const shown = colorDiffLines(allLines.slice(0, maxLines), theme);
  if (allLines.length > maxLines) {
    shown.push(theme.fg("muted", `... ${allLines.length - maxLines} more diff lines`));
  }
  return shown.join("\n");
}
