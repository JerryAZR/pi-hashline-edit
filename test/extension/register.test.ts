import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
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

    const expected = ["edit", "read", "undo"];

    // grep only registers if rg is available
    let rgOk = false;
    try {
      const r = spawnSync("rg", ["--version"], { stdio: "pipe" });
      rgOk = r.status === 0;
    } catch {
      // rg not on PATH
    }
    if (rgOk) expected.push("grep");

    expect(toolNames.sort()).toEqual(expected.sort());
  });
});
