import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepToolDefinition } from "../../src/grep";
import { makeFakePiRegistry } from "../support/fixtures";
import registerCore from "../../extensions/core";

let rgAvailable = false;
try {
  execSync("rg --version", { stdio: "pipe" });
  rgAvailable = true;
} catch {
  // rg not on PATH
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-hashline-grep-"));
  return {
    dir,
    add(filename: string, content: string) {
      writeFileSync(join(dir, filename), content, "utf-8");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("grep tool", () => {
  it("registers with correct name", () => {
    const { pi, getTool } = makeFakePiRegistry();
    pi.registerTool(grepToolDefinition);
    const tool = getTool("grep");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("grep");
  });

  it("has correct schema fields", () => {
    const schema = grepToolDefinition.parameters;
    const props = (schema as any).properties;
    expect(props.pattern).toBeDefined();
    expect(props.path).toBeDefined();
    expect(props.glob).toBeDefined();
    expect(props.ignoreCase).toBeDefined();
    expect(props.literal).toBeDefined();
    expect(props.context).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it("rejects when pattern is missing", async () => {
    await expect(
      grepToolDefinition.execute("g1", { pattern: "" }, undefined),
    ).rejects.toThrow("Pattern is required");
  });
});

describe("grep tool execution", () => {
  it.skipIf(!rgAvailable)("returns hashline-formatted matches", async () => {
    const tmp = tempDir();
    try {
      tmp.add("a.ts", "import { foo } from './foo';\nexport const bar = 42;\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "export", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      expect(text).toContain("a.ts");
      expect(text).toContain("#");
      expect(text).toContain("│");
      expect(text).toContain("export const bar = 42;");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("groups results by file", async () => {
    const tmp = tempDir();
    try {
      tmp.add("x.ts", "const x = 1;\n");
      tmp.add("y.ts", "const y = 2;\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "const", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      expect(text).toContain("x.ts");
      expect(text).toContain("y.ts");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("shows only requested context, not the extra hashing ring", async () => {
    const tmp = tempDir();
    try {
      tmp.add("f.ts", "// line 1\n// line 2\nconst x = 42;\n// line 4\n// line 5\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "const", path: tmp.dir, context: 1 },
        undefined,
      );

      const text = (result as any).content[0].text;
      // Lines 2-4 should be shown (agentContext=1 around match at line 3)
      expect(text).toContain("// line 2");
      expect(text).toContain("const x = 42;");
      expect(text).toContain("// line 4");
      // Lines 1 and 5 are the extra hashing-only ring from rgContext=2
      expect(text).not.toContain("// line 1");
      expect(text).not.toContain("// line 5");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("respects match limit", async () => {
    const tmp = tempDir();
    try {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
      tmp.add("big.ts", lines.join("\n") + "\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "line", path: tmp.dir, limit: 5 },
        undefined,
      );

      const text = (result as any).content[0].text;
      expect(text).toContain("5 matches limit reached");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("returns 'No matches found' for non-matching pattern", async () => {
    const tmp = tempDir();
    try {
      tmp.add("z.ts", "hello world\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "xyznonexistent", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      expect(text).toBe("No matches found");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("handles literal search", async () => {
    const tmp = tempDir();
    try {
      tmp.add("l.ts", "function(a+b) { return a+b; }\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "a+b", path: tmp.dir, literal: true },
        undefined,
      );

      const text = (result as any).content[0].text;
      expect(text).toContain("function(a+b)");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("hash matches the read tool for the same content", async () => {
    const tmp = tempDir();
    try {
      tmp.add("h.ts", "alpha\nbeta\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "alpha", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      // Extract the hash from the grep output
      const hashMatch = text.match(/([0-9A-F]{2})│alpha/);
      expect(hashMatch).not.toBeNull();
      const grepHash = hashMatch![1];

      // Build the same file with buildHashlineFile and verify hash matches
      const { buildHashlineFile } = await import("../../src/hashline");
      const file = buildHashlineFile("alpha\nbeta\n");
      expect(grepHash).toBe(file.lineHashes[0]);
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("grep hash matches read tool with CRLF content", async () => {
    const tmp = tempDir();
    try {
      tmp.add("crlf.ts", "alpha\r\nbeta\r\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "alpha", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      const hashMatch = text.match(/([0-9A-F]{2})│alpha/);
      expect(hashMatch).not.toBeNull();
      const grepHash = hashMatch![1];

      const { buildHashlineFile } = await import("../../src/hashline");
      const file = buildHashlineFile("alpha\r\nbeta\r\n");
      expect(grepHash).toBe(file.lineHashes[0]);
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("grep hash matches read tool with trailing whitespace", async () => {
    const tmp = tempDir();
    try {
      tmp.add("ws.ts", "hello   \nworld\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "hello", path: tmp.dir },
        undefined,
      );

      const text = (result as any).content[0].text;
      const hashMatch = text.match(/([0-9A-F]{2})│hello/);
      expect(hashMatch).not.toBeNull();
      const grepHash = hashMatch![1];

      const { buildHashlineFile } = await import("../../src/hashline");
      const file = buildHashlineFile("hello   \nworld\n");
      expect(grepHash).toBe(file.lineHashes[0]);
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("accepts anchors from grep in a subsequent edit", async () => {
    const tmp = tempDir();
    try {
      tmp.add("src.ts", "import { bar } from './bar';\nimport { foo } from './foo';\n\nconst x = foo();\n");

      // grep for 'import' → get hashed anchors
      const grepResult = await grepToolDefinition.execute(
        "g1",
        { pattern: "import", path: tmp.dir, context: 1 },
        undefined,
      );
      const grepText = (grepResult as any).content[0].text;

      // Extract a LINE#HASH anchor for the first import line
      const anchorMatch = grepText.match(/\s+(\d+)#([0-9A-F]{2})│import/);
      expect(anchorMatch).not.toBeNull();
      const anchor = `${anchorMatch![1]}#${anchorMatch![2]}`;

      // Use read to verify the anchor is valid
      const { pi, getTool } = makeFakePiRegistry();
      registerCore(pi);
      const readTool = getTool("read");
      const ctx = { cwd: tmp.dir, ui: { notify() {} } } as any;

      const readResult = await readTool.execute(
        "r1",
        { path: "src.ts" },
        undefined, undefined, ctx,
      );

      // The same anchor should appear in read output
      expect(readResult.content[0].text).toContain(`${anchor}│import`);
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("shows only match lines when context is 0", async () => {
    const tmp = tempDir();
    try {
      tmp.add("m.ts", "// one\nconst x = 1;\n// two\n");

      const result = await grepToolDefinition.execute(
        "g1",
        { pattern: "const", path: tmp.dir, context: 0 },
        undefined,
      );

      const text = (result as any).content[0].text;
      // Match line should appear
      expect(text).toContain("const x = 1;");
      // Context lines should NOT appear
      expect(text).not.toContain("// one");
      expect(text).not.toContain("// two");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("respects ignoreCase", async () => {
    const tmp = tempDir();
    try {
      tmp.add("case.ts", "FOO\nbar\n");

      const caseSensitive = await grepToolDefinition.execute(
        "g1",
        { pattern: "foo", path: tmp.dir },
        undefined,
      );
      const caseInsensitive = await grepToolDefinition.execute(
        "g1",
        { pattern: "foo", path: tmp.dir, ignoreCase: true },
        undefined,
      );

      expect((caseSensitive as any).content[0].text).toBe("No matches found");
      expect((caseInsensitive as any).content[0].text).toContain("FOO");
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!rgAvailable)("rejects with clear error for nonexistent path", async () => {
    await expect(
      grepToolDefinition.execute(
        "g1",
        { pattern: "x", path: "/nonexistent/path/that/does/not/exist" },
        undefined,
      ),
    ).rejects.toThrow("Path not found");
  });
});
