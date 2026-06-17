import { describe, expect, it } from "vitest";
import { buildHashlineFile, validateAnchors, resolveEditSpans, applySpans, formatMismatchError, computeLineHash, computeHashFromContext, normalizeLine, hashlineParseText } from "../../src/hashline";
import { partitionExact } from "../../src/fuzzy-match";
import type { HashlineEdit } from "../../src/hashline";

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

describe("computeLineHash", () => {
  it("returns a 2-character hex string", () => {
    const hash = computeLineHash(["hello"], 0);
    expect(hash).toHaveLength(2);
    expect(hash).toMatch(/^[0-9A-F]{2}$/);
  });

  it("trims trailing whitespace without collapsing internal spaces", () => {
    expect(computeLineHash(["a\t"], 0)).toBe(computeLineHash(["a"], 0));
    expect(computeLineHash(["a  b"], 0)).not.toBe(computeLineHash(["a b"], 0));
  });

  it("strips trailing CR", () => {
    expect(computeLineHash(["hello\r"], 0)).toBe(computeLineHash(["hello"], 0));
  });

  it("produces same hash for same content with same neighbors", () => {
    const h1 = computeLineHash(["prev", "}", "next"], 1);
    const h2 = computeLineHash(["prev", "}", "next"], 1);
    expect(h1).toBe(h2);
  });
});

describe("strict hashline contract", () => {
  it("preserves internal spaces when hashing", () => {
    expect(computeLineHash(["a b"], 0)).not.toBe(computeLineHash(["ab"], 0));
  });

  it("trims trailing spaces when hashing", () => {
    expect(computeLineHash(["value  "], 0)).toBe(computeLineHash(["value"], 0));
  });

  it("preserves explicit blank trailing line in array input", () => {
    expect(hashlineParseText(["alpha", ""])).toEqual(["alpha", ""]);
  });

  it("rejects stale anchors instead of relocating by hash", () => {
    const fileLines = ["a", "INSERTED", "b", "target", "c"];
    const content = fileLines.join("\n");
    const stale = {
      op: "replace",
      pos: { line: 3, hash: computeLineHash(fileLines, 3) },
      lines: ["updated"],
    };

    expect(() => applyHashlineEdits(content, [stale as any])).toThrow(
      /1 stale anchor: 3#[0-9A-F]+\./,
    );
  });

  it("computeHashFromContext matches computeLineHash", () => {
    const lines = ["  hello  ", "world", "  foo"];

    // computeLineHash normalizes internally
    const fromFile = computeLineHash(lines, 1);

    // computeHashFromContext takes pre-normalized strings
    const fromContext = computeHashFromContext(
      normalizeLine(lines[0]!),
      normalizeLine(lines[1]!),
      normalizeLine(lines[2]!),
    );

    expect(fromContext).toBe(fromFile);
  });

});
