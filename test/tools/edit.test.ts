import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import Ajv from "ajv";
import {
  assertEditRequest,
  hashlineEditToolSchema,
  registerEditTool,
} from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("assertEditRequest", () => {
  it("accepts valid replace edit", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ range: ["1#AB", "1#AB"], lines: ["x"] }],
      }),
    ).not.toThrow();
  });

});

describe("registerEditTool", () => {
  it("publishes a schema that validates strict hashline payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ range: ["1#AB", "1#AB"], lines: ["x"] }],
      }),
    ).toBe(true);
  });

  it("rejects append/prepend in published schema (hidden at runtime)", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ after: "1#AB", lines: ["x"] }],
      }),
    ).toBe(false);

    expect(
      validate({
        path: "a.ts",
        edits: [{ before: "1#AB", lines: ["x"] }],
      }),
    ).toBe(false);
  });

  it("publishes a top-level object schema for pi tool registration", () => {
    expect((hashlineEditToolSchema as any).type).toBe("object");
    expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();
  });

  it("registers the edit tool without a prepareArguments shim", () => {
    let registered:
      | {
          parameters?: any;
          prepareArguments?: (args: unknown) => unknown;
        }
      | undefined;
    const pi = {
      registerTool(tool: {
        parameters?: any;
        prepareArguments?: (args: unknown) => unknown;
      }) {
        registered = tool;
      },
    } as any;

    registerEditTool(pi);

    expect(registered?.parameters).toEqual(hashlineEditToolSchema);
    expect(registered?.prepareArguments).toBeUndefined();
  });

  it("executes strict hashline replace through the normal path", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              range: [`2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}`, `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}`],
              lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(result.details?.diff).toContain("+2");
      expect(result.details?.diff).toContain("│BBB");
    });
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            range: [`2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`, `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`],
            lines: ["BBB"],
          },
        ],
      };

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(typeof editTool.renderResult).toBe("function");

      const component = editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        {
          bold: (text: string) => text,
          fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
          inverse: (text: string) => `[inverse]${text}[/inverse]`,
        },
        {
          args: editArgs,
          isError: false,
          lastComponent: undefined,
        } as any,
      ) as { render: (width: number) => string[] };

      const rendered = component.render(200).join("\n");

      expect(rendered).not.toContain("Changes: +1 -1");
      expect(rendered).not.toContain("Diff preview:");
      expect(rendered).not.toContain("```diff");
      const hash = computeLineHash(["aaa", "BBB", "ccc"], 1);
      expect(rendered).toContain(`[success]+2#${hash}│BBB[/success]`);
      expect(rendered).not.toContain("Updated sample.txt");
      expect(rendered).not.toContain("```text");
      expect(result.details?.diff).toContain("+2");
    });
  });
});
  it("rejects edits on empty files with E_EMPTY_FILE", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "empty.txt",
            edits: [{ range: ["1#AB", "1#AB"], lines: ["hello"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/\[E_EMPTY_FILE\]/);
    });
  });
