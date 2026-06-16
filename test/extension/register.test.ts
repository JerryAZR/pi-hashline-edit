import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
  it("registers read/edit tools", () => {
    const toolNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      on() {},
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["edit", "grep", "insert", "read", "undo"]);
  });
});
