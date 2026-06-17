import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import Ajv from "ajv";
import {
  assertInsertRequest,
  insertToolSchema,
} from "../../src/insert";
import { computeLineHash } from "../../src/hashline";
import registerCore from "../../extensions/core";
import registerInsert from "../../extensions/insert";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("assertInsertRequest", () => {
  it("accepts valid insert", () => {
    expect(() =>
      assertInsertRequest({
        path: "a.ts",
        edits: [{ anchor: "1#AB", direction: "after", lines: ["x"] }],
      }),
    ).not.toThrow();
  });

  it("rejects missing path", () => {
    expect(() =>
      assertInsertRequest({ edits: [{ anchor: "1#AB", direction: "after", lines: ["x"] }] }),
    ).toThrow();
  });

  it("rejects empty edits", () => {
    expect(() =>
      assertInsertRequest({ path: "a.ts", edits: [] }),
    ).toThrow();
  });
});

describe("insertToolSchema", () => {
  it("validates insert entry", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(insertToolSchema as any);
    expect(
      validate({
        path: "a.ts",
        edits: [{ anchor: "1#AB", direction: "after", lines: ["x"] }],
      }),
    ).toBe(true);
  });

  it("rejects missing anchor", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(insertToolSchema as any);
    expect(
      validate({
        path: "a.ts",
        edits: [{ direction: "after", lines: ["x"] }],
      }),
    ).toBe(false);
  });

  it("rejects invalid direction", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(insertToolSchema as any);
    expect(
      validate({
        path: "a.ts",
        edits: [{ anchor: "1#AB", direction: "above", lines: ["x"] }],
      }),
    ).toBe(false);
  });
});

describe("insert tool execution", () => {
  it("inserts after a line", async () => {
    await withTempFile("sample.txt", "aaa\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerInsert(pi);
      const readTool = getTool("read");
      const insertTool = getTool("insert");
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readResult = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const aaaAnchor = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│aaa"))!
        .split("│")[0]!;

      await insertTool.execute(
        "i1",
        { path: "sample.txt", edits: [{ anchor: aaaAnchor, direction: "after", lines: ["bbb"] }] },
        undefined, undefined, ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("inserts before a line", async () => {
    await withTempFile("sample.txt", "bbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerInsert(pi);
      const readTool = getTool("read");
      const insertTool = getTool("insert");
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readResult = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const bbbAnchor = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await insertTool.execute(
        "i1",
        { path: "sample.txt", edits: [{ anchor: bbbAnchor, direction: "before", lines: ["aaa"] }] },
        undefined, undefined, ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("inserts at end of file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerInsert(pi);
      const readTool = getTool("read");
      const insertTool = getTool("insert");
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readResult = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const bbbAnchor = readResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await insertTool.execute(
        "i1",
        { path: "sample.txt", edits: [{ anchor: bbbAnchor, direction: "after", lines: ["ccc"] }] },
        undefined, undefined, ctx,
      );

      const after = await readFile(path, "utf-8");
      expect(after).toContain("bbb");
      expect(after).toContain("ccc");
      expect(after.indexOf("bbb")).toBeLessThan(after.indexOf("ccc"));
    });
  });

  it("rejects empty file with E_EMPTY_FILE", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerInsert(pi);
      const insertTool = getTool("insert");
      const ctx = { cwd, ui: { notify() {} } } as any;

      await expect(
        insertTool.execute(
          "i1",
          { path: "empty.txt", edits: [{ anchor: "1#AB", direction: "after", lines: ["hello"] }] },
          undefined, undefined, ctx,
        ),
      ).rejects.toThrow(/E_EMPTY_FILE/);
    });
  });
});
