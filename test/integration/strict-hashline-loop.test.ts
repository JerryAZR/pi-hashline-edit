import { describe, expect, it } from "vitest";
import registerCore from "../../extensions/core";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("strict hashline tool loop", () => {
  it("supports read -> fresh edit -> stale rejection -> retry with fresh anchor", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = firstRead.content[0].text as string;
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{ range: [betaRef, betaRef], lines: ["BETA1"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(
        editTool.execute(
          "e2",
          {
            path: "sample.ts",
            edits: [{ range: [betaRef, betaRef], lines: ["BETA2"] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);

      const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const secondText = secondRead.content[0].text as string;
      const freshRef = secondText
        .split("\n")
        .find((line: string) => line.includes("│BETA1"))!
        .split("│")[0]!;

      await editTool.execute(
        "e3",
        {
          path: "sample.ts",
          edits: [{ range: [freshRef, freshRef], lines: ["BETA2"] }],
        },
        undefined,
        undefined,
        ctx,
      );
    });
  });
});
