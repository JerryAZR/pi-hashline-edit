import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import registerCore from "../../extensions/core";
import registerInsert from "../../extensions/insert";
import registerUndo from "../../extensions/undo";
import registerGrep from "../../extensions/grep";

function collectTools(register: (pi: any) => void): string[] {
  const toolNames: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      toolNames.push(tool.name);
    },
    on() {},
    events: { emit() {}, on() {} },
  };
  register(pi);
  return toolNames;
}

describe("extension registration", () => {
  it("core registers 'edit' and 'read'", () => {
    expect(collectTools(registerCore).sort()).toEqual(["edit", "read"]);
  });

  it("insert registers 'insert'", () => {
    expect(collectTools(registerInsert).sort()).toEqual(["insert"]);
  });

  it("undo registers 'undo'", () => {
    expect(collectTools(registerUndo).sort()).toEqual(["undo"]);
  });

  it("grep registers 'grep' if rg available", () => {
    let rgOk = false;
    try {
      const r = spawnSync("rg", ["--version"], { stdio: "pipe" });
      rgOk = r.status === 0;
    } catch {
      // rg not on PATH
    }
    if (rgOk) {
      expect(collectTools(registerGrep).sort()).toEqual(["grep"]);
    }
  });
});
