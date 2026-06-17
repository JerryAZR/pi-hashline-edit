import { describe, expect, it } from "vitest";
import { hashlineParseText, computeLineHash } from "../../src/hashline";

describe("hashlineParseText", () => {
  it("returns [] for null", () => {
    expect(hashlineParseText(null)).toEqual([]);
  });

  it("splits string on newline", () => {
    expect(hashlineParseText("a\nb")).toEqual(["a", "b"]);
  });

  it("removes trailing blank line from string input", () => {
    expect(hashlineParseText("a\nb\n")).toEqual(["a", "b"]);
  });

  it("preserves a trailing whitespace-only content line in string input", () => {
    expect(hashlineParseText("a\nb\n  ")).toEqual(["a", "b", "  "]);
  });

  it("passes through array input verbatim", () => {
    const input = ["a", "b"];
    expect(hashlineParseText(input)).toEqual(["a", "b"]);
  });

  it("preserves '# Note:' comment lines (no autocorrection)", () => {
    expect(hashlineParseText(["# Note: important"])).toEqual(["# Note: important"]);
  });

  it("preserves literal '+' prefixed content (no autocorrection)", () => {
    expect(hashlineParseText(["+added"])).toEqual(["+added"]);
  });

  it("returns empty string as a single empty line for blank content", () => {
    expect(hashlineParseText("")).toEqual([""]);
  });

  it("rejects array input that contains LINE#HASH: prefixes", () => {
    expect(() => hashlineParseText(["1#D8│foo", "2#3F│bar"])).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects diff-preview hunks with + and context hash prefixes", () => {
    expect(() =>
      hashlineParseText([" 9#3F│keep", "+10#B2│new", " 11#C7│after"]),
    ).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects diff-preview deletion rows", () => {
    expect(() =>
      hashlineParseText([" 9#3F│keep", "-10    old", " 11#C7│after"]),
    ).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects string-form rendered diff hunks", () => {
    const input = " 9#3F│keep\n-10    old\n+10#B2│new\n 11#C7│after";
    expect(() => hashlineParseText(input)).toThrow(/^\[E_INVALID_PATCH\]/);
  });
});
