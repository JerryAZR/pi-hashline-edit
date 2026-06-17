import { describe, expect, it } from "vitest";
import {
  buildHashlineFile,
  validateAnchors,
  resolveEditSpans,
  applySpans,
  formatMismatchError,
  computeLineHash,
  resolveEditAnchors,
  type Anchor,
  type HashlineEdit,
  type HashlineToolEdit,
} from "../../src/hashline";
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

function makeTag(content: string, lineNum: number): Anchor {
  const fileLines = content.split("\n");
  return { line: lineNum, hash: computeLineHash(fileLines, lineNum - 1) };
}

describe("applyHashlineEdits — error handling", () => {
  it("throws on hash mismatch", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "replace", pos: { line: 2, hash: "XX" }, lines: ["BBB"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(/1 stale anchor: 2#XX\./);
  });

  it("throws on out-of-range line", () => {
    const content = "aaa\nbbb";
    const edits = [
      { op: "replace", pos: { line: 99, hash: "AB" }, lines: ["x"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(/does not exist/);
  });

  it("throws on range start > end", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 3),
        end: makeTag(content, 1),
        lines: ["x"],
      },
    ];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/must be <= end line/);
  });

  it("reports multiple mismatches at once", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
      { op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(/2 stale anchors: 1#XX, 3#YY\./);
  });

  it("range error takes priority over stale anchors", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
      {
        op: "replace",
        pos: makeTag(content, 3),
        end: makeTag(content, 1),
        lines: ["x"],
      },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(/must be <= end line/);
  });
  it("mismatch message exposes retryable >>> LINE#HASH snippets", () => {
    expect(() =>
      applyHashlineEdits("aaa", [
        {
          op: "replace",
          pos: { line: 1, hash: "AB" },
          lines: ["bbb"],
        } as any,
      ]),
    ).toThrow(/>>> 1#[0-9A-F]{2}│aaa/);
  });

  it("retains still-valid range endpoints in retry snippets", () => {
    const content = "aaa\nbbb\nccc\nddd\neee";
    const validEnd = makeTag(content, 5);

    try {
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: { line: 1, hash: "AB" },
          end: validEnd,
          lines: ["AAA"],
        },
      ]);
      throw new Error("Expected applyHashlineEdits to throw for stale range anchor.");
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toContain(
        `>>> ${validEnd.line}#${validEnd.hash}│eee`,
      );
    }
  });

  it("rejects overlapping replace ranges in one request", () => {
    const content = "aaa\nbbb\nccc\nddd";
    expect(() =>
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: makeTag(content, 2),
          end: makeTag(content, 3),
          lines: ["X"],
        },
        {
          op: "replace",
          pos: makeTag(content, 3),
          lines: ["Y"],
        },
      ]),
    ).toThrow(/conflicting edits.*overlap on the same original line range/i);
  });
});

describe("applyHashlineEdits — heuristics", () => {
  it("preserves trailing boundary-looking lines in replacements", () => {
    const content = "if (ok) {\n  run();\n}\nafter();";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 1),
        end: makeTag(content, 2),
        lines: ["if (ok) {", "  runSafe();", "}"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
    expect(result.warnings).toBeUndefined();
  });

  it("preserves leading boundary-looking lines in replacements", () => {
    const content = "before();\nif (ok) {\n  run();\n}\nafter();";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 3),
        lines: ["before();", "if (ok) {", "  runSafe();"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe(
      "before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();",
    );
    expect(result.warnings?.[0]).toContain(
      "Potential boundary duplication before",
    );
  });

  it("does not auto-correct escaped tab indentation even when the env flag is set", () => {
    const previous = process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
    process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = "1";

    try {
      const content = "root\n\tchild\n\t\tvalue\nend";
      const edits = [
        {
          op: "replace",
          pos: makeTag(content, 3),
          lines: ["\\t\\treplaced"],
        },
      ];
      const result = applyHashlineEdits(content, edits);

      expect(result.content).toBe("root\n\tchild\n\\t\\treplaced\nend");
      expect(result.warnings).toBeUndefined();
      expect(edits[0]).toEqual({
        op: "replace",
        pos: makeTag(content, 3),
        lines: ["\\t\\treplaced"],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
      } else {
        process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
      }
    }
  });

  it("warns on literal \\uDDDD without changing content", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
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

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
  it("full pipeline: tool-schema edit → resolve → apply", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: ["BBB"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: string lines get parsed correctly", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: "BBB" }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: null lines → delete", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: null }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nccc");
  });

  it("full pipeline: hashline-prefixed string lines are rejected (no autocorrection)", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}│bbb`;
    const hash = computeLineHash(["BBB"], 0);
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: `2#${hash}│BBB` },
    ];
    expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("full pipeline: copied full-line anchor rejects fuzzy textHint when hash is arbitrary", () => {
    const line = 'he said "hi"';
    const content = `${line}\nkeep`;
    const actualHash = computeLineHash([line], 0);
    const arbitraryHash = actualHash === "AB" ? "CD" : "AB";
    const staleWithHint = `1#${arbitraryHash}│${line}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: staleWithHint, lines: ["HELLO"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);

    expect(() => applyHashlineEdits(content, resolved)).toThrow(/stale anchor/);
  });

  it("full pipeline: copied diff-preview hunks are rejected (no autocorrection)", () => {
    const content = "aaa\nbbb\nccc";
    const start = `1#${computeLineHash(["aaa"], 0)}`;
    const end = `3#${computeLineHash(["ccc"], 0)}`;
    const replacement = [
      ` 1#${computeLineHash(["aaa"], 0)}│aaa`,
      "-2    bbb",
      `+2#${computeLineHash(["BBB"], 0)}│BBB`,
      ` 3#${computeLineHash(["ccc"], 0)}│ccc`,
    ].join("\n");
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: start, end, lines: replacement },
    ];
    expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
  });
});