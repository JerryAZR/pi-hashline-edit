import { describe, expect, it } from "vitest";
import { buildHashlineFile, validateAnchors, resolveEditSpans, applySpans, formatMismatchError, computeLineHash, type HashlineEdit } from "../../src/hashline";
import { partitionExact } from "../../src/fuzzy-match";

function applyHashlineEdits(content: string, edits: HashlineEdit[], signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("AbortError");
  const file = buildHashlineFile(content);
  const struct = validateAnchors(file, edits);
  if (!struct.ok) throw new Error(struct.message);
  const exact = partitionExact(edits, file);
  if (exact.unmatched.length > 0) {
    const mismatches = exact.unmatched.flatMap((e) => {
      const refs = e.end ? [e.pos, e.end] : [e.pos];
      return refs.map((r) => ({
        line: r.line,
        expected: r.hash,
        actual: file.lineHashes[r.line - 1] ?? "OOB",
      }));
    });
    const retryLines = new Set(mismatches.map((m) => m.line));
    throw new Error(formatMismatchError(mismatches, file.lines, retryLines));
  }
  const spanResult = resolveEditSpans(file, edits);
  if (!spanResult.ok) throw new Error(spanResult.message);
  const applied = applySpans(file, spanResult.spans);
  return {
    content: applied.file.content,
    firstChangedLine: applied.firstChangedLine,
    lastChangedLine: applied.lastChangedLine,
    warnings: spanResult.warnings.length ? spanResult.warnings : undefined,
    noopEdits: spanResult.noopEdits.length ? spanResult.noopEdits : undefined,
  };
}

function makeTag(content: string, line: number) {
  const fileLines = content.split("\n");
  return { line, hash: computeLineHash(fileLines, line - 1) };
}

describe("applyHashlineEdits — basic operations", () => {
  it("returns content unchanged for empty edits", () => {
    const result = applyHashlineEdits("hello\nworld", []);
    expect(result.content).toBe("hello\nworld");
    expect(result.firstChangedLine).toBeUndefined();
  });

  it("replaces a single line", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(content, 2), lines: ["BBB"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
    expect(result.firstChangedLine).toBe(2);
  });

  it("replaces a single line with multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(content, 2), lines: ["BBB", "B2"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nB2\nccc");
  });

  it("deletes a single line (empty lines array)", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(content, 2), lines: [] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nccc");
  });

  it("replaces a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(content, 2),
      end: makeTag(content, 3),
      lines: ["BBB", "CCC"],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
  });

  it("deletes a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(content, 2),
      end: makeTag(content, 3),
      lines: [],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nddd");
  });
});

describe("applyHashlineEdits — multi-edit ordering", () => {
  it("applies multiple edits bottom-up correctly", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 1), lines: ["AAA"] },
      { op: "replace", pos: makeTag(content, 3), lines: ["CCC"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("AAA\nbbb\nCCC");
  });

  it("deduplicates identical edits", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(content, 2);
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("does not mutate caller-owned edit arrays while deduplicating", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(content, 2);
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];

    applyHashlineEdits(content, edits);

    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({ op: "replace", pos: { ...pos }, lines: ["BBB"] });
    expect(edits[1]).toEqual({ op: "replace", pos: { ...pos }, lines: ["BBB"] });
  });
});

describe("applyHashlineEdits — noop detection", () => {
  it("detects single-line noop", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(content, 2), lines: ["bbb"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
    expect(result.noopEdits![0].editIndex).toBe(0);
  });

  it("detects range noop", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(content, 2),
      end: makeTag(content, 3),
      lines: ["bbb", "ccc"],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
  });
});

describe("applyHashlineEdits — warning heuristics", () => {
  it("warns on literal \\uDDDD without changing content", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        lines: ["\\uDDDD"],
      },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.content).toBe("aaa\n\\uDDDD\nccc");
    expect(result.warnings?.[0]).toContain("Detected literal \\uDDDD");
  });
});

describe("applyHashlineEdits — lastChangedLine tracking", () => {
  it("tracks lastChangedLine when single-line replace expands to multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: ["B1", "B2", "B3", "B4", "B5"] },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(6);
  });

  it("tracks lastChangedLine correctly for single-line delete", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(content, 2), lines: [] }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(2);
  });

  it("tracks lastChangedLine correctly for multi-line delete", () => {
    const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(content, 2),
      end: makeTag(content, 4),
      lines: [],
    }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(4);
  });
});

