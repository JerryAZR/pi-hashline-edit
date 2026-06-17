import { describe, expect, it } from "vitest";
import { buildHashlineFile } from "../../src/hashline";
import {
  partitionExact,
  fuzzyMatch,
} from "../../src/fuzzy-match";

function makeEdit(
  startLine: number,
  startHash: string,
  endLine?: number,
  endHash?: string,
) {
  return {
    op: "replace" as const,
    pos: { line: startLine, hash: startHash },
    end: endLine !== undefined
      ? { line: endLine, hash: endHash ?? "" }
      : undefined,
    lines: ["REPLACED"],
  };
}

describe("partitionExact", () => {
  it("splits edits by hash match", () => {
    const file = buildHashlineFile("a\nb\nc\n");
    const h1 = file.lineHashes[0]!;
    const h2 = file.lineHashes[1]!;

    const edit1 = makeEdit(1, h1);
    const edit2 = makeEdit(2, "XX");
    const edit3 = makeEdit(2, h2);

    const result = partitionExact([edit1, edit2, edit3], file);

    expect(result.matched).toHaveLength(2);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]!.pos.hash).toBe("XX");
    expect(result.warnings).toEqual([]);
  });

  it("detects OOB as unmatched", () => {
    const file = buildHashlineFile("a\nb\n");
    const edit = makeEdit(5, "XX");
    const result = partitionExact([edit], file);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("checks both anchors for range edits", () => {
    const file = buildHashlineFile("a\nb\nc\n");
    const h1 = file.lineHashes[0]!;
    const h3 = file.lineHashes[2]!;

    const badEnd = makeEdit(1, h1, 3, "XX");
    const result = partitionExact([badEnd], file);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });
});

describe("fuzzyMatch", () => {
  it("relocates when file shifts down by external insertion", () => {
    // Original: a b c d e
    // External inserts X at top
    // Current: X a b c d e
    // Edit for "c" — line 3 → line 4, hash unchanged
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("X\na\nb\nc\nd\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 3, hash: original.lineHashes[2]! },
      lines: ["C"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.pos.line).toBe(4);
    expect(result.matched[0]!.pos.hash).toBe(original.lineHashes[2]); // unchanged
    expect(result.unmatched).toHaveLength(0);
    expect(result.warnings).toContain("[RELOCATED] 1 range(s) relocated via hash matching. Please review the diff carefully.");
  });

  it("relocates when file shifts up by external deletion", () => {
    // Original: a b c d e
    // External deletes "a"
    // Current: b c d e
    // Edit for "c" — line 3 → line 2, hash unchanged
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("b\nc\nd\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 3, hash: original.lineHashes[2]! },
      lines: ["C"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.pos.line).toBe(2);
    expect(result.matched[0]!.pos.hash).toBe(original.lineHashes[2]);
    expect(result.unmatched).toHaveLength(0);
  });

  it("rejects when hash not found within offset", () => {
    // Original: a b c d e
    // External deletes "c" entirely
    // Current: a b d e
    // Edit for "c" — hash doesn't exist in current
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("a\nb\nd\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 3, hash: original.lineHashes[2]! },
      lines: ["C"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("rejects on multiple hash matches", () => {
    // 4 identical lines — lines 2 and 3 both have neighbors (x, x, x),
    // so both share the same hash. Within +-1 of line 2, both match.
    const file = buildHashlineFile("x\nx\nx\nx\n");
    // Line 2 and 3 share the same hash: fnv(x + "\t" + x + "\t" + x)
    const h2 = file.lineHashes[1]!;
    const h3 = file.lineHashes[2]!;
    expect(h2).toBe(h3); // same neighbors, same hash

    const edit = {
      op: "replace" as const,
      pos: { line: 2, hash: h2 },
      lines: ["X"],
    };

    const result = fuzzyMatch([edit], file);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("handles multi-line ranges", () => {
    // Original: a b c d e f
    // External inserts X at top → all hashes unchanged
    // Current: X a b c d e f
    // Edit for range [b, c, d] (lines 2-4)
    const original = buildHashlineFile("a\nb\nc\nd\ne\nf\n");
    const current = buildHashlineFile("X\na\nb\nc\nd\ne\nf\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      end: { line: 4, hash: original.lineHashes[3]! },
      lines: ["B", "C", "D"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.pos.line).toBe(3);
    expect(result.matched[0]!.pos.hash).toBe(original.lineHashes[1]);
    expect(result.matched[0]!.end!.line).toBe(5);
    expect(result.matched[0]!.end!.hash).toBe(original.lineHashes[3]);
  });

  it("rejects multi-line when end hash doesn't match", () => {
    // Original: a b c d e
    // Current: a b c X e (d replaced by X — end hash doesn't match)
    // Edit for range [b, c, d] — pos matches, end doesn't
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("a\nb\nc\nX\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      end: { line: 4, hash: original.lineHashes[3]! },
      lines: ["B", "C", "D"],
    };

    const result = fuzzyMatch([edit], current);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("respects file boundaries (won't shift past start)", () => {
    // Original: a b c
    // External deletes "a"
    // Current: b c
    // Edit for "a" — hash doesn't exist in current
    const original = buildHashlineFile("a\nb\nc\n");
    const current = buildHashlineFile("b\nc\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 1, hash: original.lineHashes[0]! },
      lines: ["A"],
    };

    const result = fuzzyMatch([edit], current);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("respects file boundaries (won't shift past end)", () => {
    // Original: a b c
    // External deletes "c"
    // Current: a b
    // Edit for "c" — hash doesn't exist in current
    const original = buildHashlineFile("a\nb\nc\n");
    const current = buildHashlineFile("a\nb\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 3, hash: original.lineHashes[2]! },
      lines: ["C"],
    };

    const result = fuzzyMatch([edit], current);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("rejects when hash changed (neighbor modified)", () => {
    // Original: a b c d e
    // External inserts X between b and c → c's hash changes
    // Current: a b X c d e
    // Edit for "c" — old hash no longer exists → unmatched
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("a\nb\nX\nc\nd\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 3, hash: original.lineHashes[2]! },
      lines: ["C"],
    };

    const result = fuzzyMatch([edit], current);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("rejects when hash changed (content same, neighbor deleted)", () => {
    // Original: a b c d e
    // External deletes c → b's hash changes (neighbor below was c, now d)
    // Edit for "b" — old hash no longer exists → unmatched
    const original = buildHashlineFile("a\nb\nc\nd\ne\n");
    const current = buildHashlineFile("a\nb\nd\ne\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      lines: ["B"],
    };

    const result = fuzzyMatch([edit], current);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("relocates at exactly the search boundary (±1 for single-line)", () => {
    // Original: a b c d e f
    // External inserts X at top → b shifts from line 2 to line 3 (offset +1)
    // Edit for "b" — hash unchanged, found at the boundary
    const original = buildHashlineFile("a\nb\nc\nd\ne\nf\n");
    const current = buildHashlineFile("X\na\nb\nc\nd\ne\nf\n");

    const edit = {
      op: "replace" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      lines: ["B"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.pos.line).toBe(3);
    expect(result.unmatched).toHaveLength(0);
  });

  it("resolves multiple stale edits in one batch", () => {
    // Original: a b c d e f g
    // External inserts X at top → all lines shift +1, hashes unchanged
    // Edits for b, d, f
    const original = buildHashlineFile("a\nb\nc\nd\ne\nf\ng\n");
    const current = buildHashlineFile("X\na\nb\nc\nd\ne\nf\ng\n");

    const editB = {
      op: "replace" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      lines: ["B"],
    };
    const editD = {
      op: "replace" as const,
      pos: { line: 4, hash: original.lineHashes[3]! },
      lines: ["D"],
    };
    const editF = {
      op: "replace" as const,
      pos: { line: 6, hash: original.lineHashes[5]! },
      lines: ["F"],
    };

    const result = fuzzyMatch([editB, editD, editF], current);

    expect(result.matched).toHaveLength(3);
    expect(result.matched[0]!.pos.line).toBe(3);
    expect(result.matched[1]!.pos.line).toBe(5);
    expect(result.matched[2]!.pos.line).toBe(7);
    expect(result.unmatched).toHaveLength(0);
    expect(result.warnings).toContain("[RELOCATED] 3 range(s) relocated via hash matching. Please review the diff carefully.");
  });

  it("handles append/prepend (single anchor, no end)", () => {
    const original = buildHashlineFile("a\nb\nc\n");
    const current = buildHashlineFile("X\na\nb\nc\n");

    const edit = {
      op: "append" as const,
      pos: { line: 2, hash: original.lineHashes[1]! },
      lines: ["inserted"],
    };

    const result = fuzzyMatch([edit], current);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.pos.line).toBe(3);
    expect(result.unmatched).toHaveLength(0);
  });
});
