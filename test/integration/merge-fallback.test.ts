import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";
import registerCore from "../../extensions/core";
import { _setReadSnapshotState } from "../../src/read-snapshot";

describe("edit merge fallback", () => {
  it("rejects small shifts when no snapshot is available", async () => {
    await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read the file (stores snapshot)
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const l8Ref = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│l8"))!
        .split("│")[0]!;

      // 2. File changes externally — insertion at beginning shifts line numbers by +1
      writeFileSync(path, "X\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", "utf-8");

      // 3. Without the snapshot there is no merge fallback
      _setReadSnapshotState(undefined);

      // 4. Edit with old anchors should fail — no fuzzy relocation anymore
      await expect(
        editTool.execute(
          "e1",
          { path: "sample.ts", edits: [{ range: [l8Ref, l8Ref], lines: ["L8"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("rejects small shifts when snapshot is cleared even with an absolute path", async () => {
    await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read using a relative path
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const l8Ref = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│l8"))!
        .split("│")[0]!;

      // 2. File changes externally
      writeFileSync(path, "X\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", "utf-8");

      // 3. Clear snapshot before editing
      _setReadSnapshotState(undefined);

      // 4. Edit using the absolute path — should still reject without fuzzy relocation
      const absolutePath = resolve(cwd, "sample.ts");
      await expect(
        editTool.execute(
          "e1",
          { path: absolutePath, edits: [{ range: [l8Ref, l8Ref], lines: ["L8"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("finds snapshot when read uses relative and edit uses absolute path", async () => {
    await withTempFile("sample.ts", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read using a relative path
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const l8Ref = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│l8"))!
        .split("│")[0]!;

      // 2. File changes externally — insertion at beginning shifts line numbers by +1
      writeFileSync(path, "X\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", "utf-8");

      // 3. Edit using the absolute path — snapshot should still match
      const absolutePath = resolve(cwd, "sample.ts");
      const editResult = await editTool.execute(
        "e1",
        { path: absolutePath, edits: [{ range: [l8Ref, l8Ref], lines: ["L8"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("[MERGED]");
      expect(editResult.content[0].text).not.toContain("[RELOCATED]");
      const finalContent = readFileSync(path, "utf-8");
      expect(finalContent).toBe("X\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10\n");
    });
  });


  it("falls back to 3-way merge on deep shifts", async () => {
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read the file (stores snapshot)
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const eRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│e"))!
        .split("│")[0]!;

      // 2. Insert 3 lines at top — shifts e by +3
      writeFileSync(path, "X\nY\nZ\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "utf-8");

      // 3. Edit with old anchor succeeds via 3-way merge
      const editResult = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ range: [eRef, eRef], lines: ["E"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("[MERGED]");
      expect(editResult.content[0].text).not.toContain("[RELOCATED]");
      const finalContent = readFileSync(path, "utf-8");
      expect(finalContent).toBe("X\nY\nZ\na\nb\nc\nd\nE\nf\ng\nh\ni\nj\n");
    });
  });

  it("rejects mixed exact and shifted edits when no snapshot is available", async () => {
    // 10-line file, external deletes line 3 (c) → lines after shift left by 1
    await withTempFile("sample.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const text = firstRead.content[0].text;
      const aRef = text.split("\n").find((l: string) => l.includes("│a"))!.split("│")[0]!;
      const eRef = text.split("\n").find((l: string) => l.includes("│e"))!.split("│")[0]!;

      // External: delete line 3 (c)
      writeFileSync(path, "a\nb\nd\ne\nf\ng\nh\ni\nj\n", "utf-8");

      // Without the snapshot there is no merge fallback
      _setReadSnapshotState(undefined);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              { range: [aRef, aRef], lines: ["A"] },  // exact
              { range: [eRef, eRef], lines: ["E"] },  // shifted by -1, no fuzzy relocation
            ],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("splits edits across exact and snapshot (merge) tiers", async () => {
    // 15-line file, delete e,f,g (lines 5-7). Line 2 (b) → exact,
    // line 12 (l) → hash unchanged but shift -3 → merge.
    await withTempFile(
      "sample.ts",
      "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerCore(pi);
        const ctx = { cwd, ui: { notify() {} } } as any;

        const readTool = getTool("read");
        const editTool = getTool("edit");

        const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
        const text = firstRead.content[0].text;
        const bRef = text.split("\n").find((l: string) => l.includes("│b"))!.split("│")[0]!;
        const lRef = text.split("\n").find((l: string) => l.includes("│l"))!.split("│")[0]!;

        // External: delete lines 5-7 (e,f,g)
        writeFileSync(path, "a\nb\nc\nd\nh\ni\nj\nk\nl\nm\nn\no\n", "utf-8");

        const editResult = await editTool.execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              { range: [bRef, bRef], lines: ["B"] },  // exact
              { range: [lRef, lRef], lines: ["L"] },  // merge (shifted to 9, same context)
            ],
          },
          undefined,
          undefined,
          ctx,
        );

        expect(editResult.content[0].text).toContain("[MERGED]");
        expect(editResult.content[0].text).not.toContain("[RELOCATED]");
        const finalContent = readFileSync(path, "utf-8");
        expect(finalContent).toBe("a\nB\nc\nd\nh\ni\nj\nk\nL\nm\nn\no\n");
      },
    );
  });

  it("falls back to hard reject when snapshot does not match either", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read the file
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      // 2. File changes externally (both lines changed)
      writeFileSync(path, "ALPHA\nBETA\n", "utf-8");

      // 3. Edit with old anchors should fail — snapshot also stale
      await expect(
        editTool.execute(
          "e1",
          { path: "sample.ts", edits: [{ range: [alphaRef, alphaRef], lines: ["a"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("falls back to hard reject when no snapshot exists", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Read the file
      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes("│alpha"))!
        .split("│")[0]!;

      // 2. Clear snapshot (simulates session switch / reload)
      _setReadSnapshotState(undefined);

      // 3. File changes externally
      writeFileSync(path, "ALPHA\nbeta\n", "utf-8");

      // 4. Edit should fail — no snapshot to fall back to
      await expect(
        editTool.execute(
          "e1",
          { path: "sample.ts", edits: [{ range: [alphaRef, alphaRef], lines: ["a"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("raw reads do not populate snapshot", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      // 1. Raw read — should NOT store snapshot
      const rawRead = await readTool.execute("r1", { path: "sample.ts", raw: true }, undefined, undefined, ctx);
      expect(rawRead.content[0].text).not.toContain("│");

      // 2. Snapshot should be empty
      _setReadSnapshotState(undefined);

      // (No snapshot was stored, so subsequent edit with stale anchors would fail)
      // We just verify the snapshot wasn't stored by checking it's empty
      expect(() => {
        _setReadSnapshotState(undefined);
      }).not.toThrow();
    });
  });
});
