import { describe, expect, it } from "vitest";
import registerCore from "../../extensions/core";
import registerUndo from "../../extensions/undo";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";
import { _setLastSnapshot, _setCurrentTurn, _resetUndo } from "../../src/undo";

describe("undo tool", () => {
  it("rejects when no edit has been made", async () => {
    await withTempFile("empty.ts", "hello\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerUndo(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const undoTool = getTool("undo");
      await expect(
        undoTool.execute("u1", {}, undefined, undefined, ctx),
      ).rejects.toThrow(/E_NO_UNDO/);
    });
  });

  it("reverts the most recent edit", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerUndo(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ range: [betaRef, betaRef], lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      _setLastSnapshot("sample.ts", "alpha\nbeta\n");

      const undoResult = await undoTool.execute("u1", {}, undefined, undefined, ctx);
      expect(undoResult.content[0].text).toContain("│beta");

      // Verify file is restored
      const afterUndo = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(afterUndo.content[0].text).toContain("│beta");
      expect(afterUndo.content[0].text).not.toContain("│BETA");
    });
  });

  it("consumes the undo slot after success", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerUndo(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ range: [alphaRef, alphaRef], lines: ["ALPHA"] }] },
        undefined,
        undefined,
        ctx,
      );

      _setLastSnapshot("sample.ts", "alpha\n");

      await undoTool.execute("u1", {}, undefined, undefined, ctx);
      await expect(
        undoTool.execute("u2", {}, undefined, undefined, ctx),
      ).rejects.toThrow(/E_NO_UNDO/);
    });
  });

  it("does not set undo slot for noop edits", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerUndo(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      // Noop edit — identical content
      await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ range: [alphaRef, alphaRef], lines: ["alpha"] }] },
        undefined,
        undefined,
        ctx,
      );

      // Undo should fail because no actual mutation happened
      await expect(
        undoTool.execute("u1", {}, undefined, undefined, ctx),
      ).rejects.toThrow(/E_NO_UNDO/);
    });
  });

  it("rejects when the edit is too old", async () => {
    await withTempFile("sample.ts", "alpha\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      registerUndo(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ range: [alphaRef, alphaRef], lines: ["ALPHA"] }] },
        undefined,
        undefined,
        ctx,
      );

      _setLastSnapshot("sample.ts", "alpha\n", 0);
      // Simulate 4 turns passing
      _setCurrentTurn(4);

      await expect(
        undoTool.execute("u1", {}, undefined, undefined, ctx),
      ).rejects.toThrow(/turns ago/);
    });
  });
  });

describe("undo state helpers", () => {
  it("_setLastSnapshot and _resetUndo work", () => {
    _resetUndo();
    _setLastSnapshot("foo.ts", "hello\n", 0);
    _resetUndo();
  });
});
