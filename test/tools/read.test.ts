import { describe, it, expect, vi, beforeEach } from "vitest";
import registerCore from "../../extensions/core";
import { formatHashlineRegion } from "../../src/hashline";
import { formatHashlineReadPreview } from "../../src/read";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
  loadFileKindAndText: vi.fn(),
  classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("formatHashlineReadPreview", () => {
  it("refuses to emit a truncated hashline for an oversized first line", () => {
    const longLine = "x".repeat(70_000);
    const result = formatHashlineReadPreview(longLine, { offset: 1 });

    expect(result.text).toContain("Hashline output requires full lines");
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it("formats ordinary lines as full hashlines", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 1 });

    expect(result.text).toContain("1#");
    expect(result.text).toContain("│alpha");
  });

  it("pads line numbers to the same width within the returned block", () => {
    const allLines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
    const text = allLines.join("\n");
    const result = formatHashlineReadPreview(text, { offset: 8 });

    expect(result.text.split("\n").slice(0, 3)).toEqual([
      ` 8#${computeLineHash(allLines, 7)}│line-8`,
      ` 9#${computeLineHash(allLines, 8)}│line-9`,
      `10#${computeLineHash(allLines, 9)}│line-10`,
    ]);
  });

  it("returns an advisory for empty files instead of a synthetic empty-line anchor", () => {
    const result = formatHashlineReadPreview("", { offset: 1 });

    expect(result.text).toContain("File is empty");
    expect(result.text).toContain("write tool");
    expect(result.text).not.toContain("1#");
  });

  it("hides the terminal newline sentinel from preview output", () => {
    const result = formatHashlineReadPreview("alpha\nbeta\n", { offset: 1 });

    expect(result.text).toContain("1#");
    expect(result.text).toContain("2#");
    expect(result.text).toContain("│alpha");
    expect(result.text).toContain("│beta");
    expect(result.text).not.toContain("3#");
    expect(result.text).not.toContain("2 lines total");
  });

  it("keeps continuation hints for partial previews", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", {
      offset: 1,
      limit: 1,
    });

    expect(result.text).toContain("Use offset=2 to continue");
  });

  it("reports when offset is beyond end of content", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 10 });

    expect(result.text).toContain("Offset 10 is beyond end of file");
    expect(result.text).toContain("2 lines total");
  });

  it("rejects fractional offsets", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { offset: 1.5 }),
    ).toThrow(/offset.*positive integer/i);
  });

  it("rejects non-positive limits", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { limit: 0 }),
    ).toThrow(/limit.*positive integer/i);
  });
});

describe("formatHashlineRegion", () => {
  it("formats lines with LINE#HASH anchors starting from the given line number", () => {
    const fileLines = ["", "", "", "", "alpha", "beta", "gamma"];
    const result = formatHashlineRegion(fileLines, 5, 7);

    expect(result).toBe(
      `5#${computeLineHash(fileLines, 4)}│alpha\n` +
      `6#${computeLineHash(fileLines, 5)}│beta\n` +
      `7#${computeLineHash(fileLines, 6)}│gamma`,
    );
  });

  it("pads region line numbers to the widest line number", () => {
    const fileLines = ["", "", "", "", "", "", "", "alpha", "beta", "gamma"];
    const result = formatHashlineRegion(fileLines, 8, 10);

    expect(result).toBe(
      ` 8#${computeLineHash(fileLines, 7)}│alpha\n` +
      ` 9#${computeLineHash(fileLines, 8)}│beta\n` +
      `10#${computeLineHash(fileLines, 9)}│gamma`,
    );
  });

  it("handles a single line", () => {
    const result = formatHashlineRegion(["hello"], 1, 1);
    expect(result).toBe(`1#${computeLineHash(["hello"], 0)}│hello`);
  });

  it("handles empty array", () => {
    const result = formatHashlineRegion([], 1, 1);
    expect(result).toBe("");
  });
});

describe("read tool protocol", () => {
  beforeEach(() => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
  });

  it("returns the empty-file advisory through the registered tool", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "" });

      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "empty.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("File is empty");
      expect(result.content[0].text).not.toContain("1#");
    });
  });

  it("omits the trailing newline sentinel through the registered tool", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "alpha\nbeta\n" });

      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("│alpha");
      expect(result.content[0].text).toContain("│beta");
      expect(result.content[0].text).not.toContain("3#");
    });
  });

  it("uses the shared text loader instead of classifying then re-reading text files", async () => {
    await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({ kind: "text", text: "alpha\nbeta\n" });

      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("│alpha");
      expect(result.content[0].text).toContain("│beta");
    });
  });
});
