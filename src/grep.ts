/**
 * Grep tool with hashline output.
 *
 * Spawns ripgrep with --context to get surrounding lines from JSON events,
 * then formats results with LINE#HASH│ anchors. No file reads needed —
 * all line content comes from rg's JSON output.
 */

import { stat as fsStat } from "fs/promises";
import { createInterface } from "readline";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { relative, basename, join } from "path";
import { homedir } from "os";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveToCwd } from "./path-utils";
import { normalizeLine, computeHashFromContext } from "./hashline";
import { stripBom } from "./edit-diff";

// ─── Schema ───────────────────────────────────────────────────────────

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

type GrepParams = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_OUTPUT_CHARS = 50 * 1024;
const MAX_LINE_CHARS = 500;

// ─── ripgrep ──────────────────────────────────────────────────────────

/**
 * Find rg: check pi's bin directory, then system PATH.
 * Synchronous so registerGrepTool can gate registration.
 */
function findRgPath(): string | null {
  // Pi's bin dir (same as ensureTool("rg"))
  const piBin = join(homedir(), ".pi", "bin");
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  const localPath = join(piBin, rgName);
  if (existsSync(localPath)) return localPath;

  // System PATH
  try {
    const result = spawnSync("rg", ["--version"], { stdio: "pipe" });
    if (result.status === 0) return "rg";
  } catch {
    // not found
  }

  return null;
}

const rgPath: string | null = findRgPath();

async function getRgPath(): Promise<string | null> {
  return rgPath;
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface LineEntry {
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

/**
 * Normalize a line from ripgrep JSON output to match hashline.ts normalizeLine.
 * rg includes the trailing line ending (\n or \r\n). We strip the BOM (first
 * line only), remove the trailing newline, then apply trimEnd to match
 * normalizeLine's behavior exactly.
 */
function normalizeRgLine(raw: string, isFirstLine: boolean): string {
  const noBom = isFirstLine ? stripBom(raw).text : raw;
  const stripped = noBom.endsWith("\n") ? noBom.slice(0, -1) : noBom;
  return normalizeLine(stripped);
}

function truncateLine(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LINE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_LINE_CHARS) + "…", truncated: true };
}

function formatPath(filePath: string, searchPath: string, isDirectory: boolean): string {
  if (isDirectory) {
    const rel = relative(searchPath, filePath);
    if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
  }
  return basename(filePath);
}

// ─── Tool description ─────────────────────────────────────────────────

const GREP_DESC = readFileSync(
  new URL("../tool-descriptions/grep.md", import.meta.url),
  "utf-8",
).trim();

const GREP_SNIPPET = readFileSync(
  new URL("../tool-descriptions/grep-snippet.md", import.meta.url),
  "utf-8",
).trim();

// ─── Tool definition ──────────────────────────────────────────────────

export const grepToolDefinition: ToolDefinition<typeof grepSchema, undefined, undefined> = {
  name: "grep",
  label: "grep",
  description: GREP_DESC,
  promptSnippet: GREP_SNIPPET,
  parameters: grepSchema,

  renderCall(args, theme, context) {
    const params = args as Partial<GrepParams>;
    const p = params.pattern || "";
    const dir = params.path || ".";
    const { glob } = params;
    let text = theme.fg("toolTitle", theme.bold("grep")) + " ";
    text += theme.fg("accent", `/${p}/`);
    text += theme.fg("toolOutput", ` in ${dir}`);
    if (glob) text += theme.fg("toolOutput", ` (${glob})`);
    if (params.limit !== undefined) text += theme.fg("toolOutput", ` limit ${params.limit}`);
    const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    component.setText(text);
    return component;
  },

  renderResult(result, options, theme, context) {
    const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const output = (result as any)?.content?.[0]?.text ?? "";
    const lines = output.split("\n");
    const maxLines = options.expanded ? lines.length : 15;
    const shown = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    let display = shown.join("\n");
    if (remaining > 0) display += theme.fg("muted", `\n... (${remaining} more lines, expand to see)`);
    component.setText(display);
    return component;
  },

  async execute(_toolCallId, rawParams, signal) {
    const params = rawParams as GrepParams;
    const { pattern } = params;
    const searchDir = params.path;
    const { glob } = params;
    const ignoreCase = params.ignoreCase ?? false;
    const literal = params.literal ?? false;
    const agentContext = params.context && params.context > 0 ? params.context : 0;
    const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_LIMIT);

    if (!pattern) throw new Error("Pattern is required");
    if (signal?.aborted) throw new Error("Operation aborted");

    const rgExe = await getRgPath();
    if (!rgExe) {
      throw new Error("ripgrep (rg) is not available. Install it: https://github.com/BurntSushi/ripgrep");
    }

    const searchPath = resolveToCwd(searchDir || ".", process.cwd());
    let isDirectory: boolean;
    try {
      isDirectory = (await fsStat(searchPath)).isDirectory();
    } catch {
      throw new Error(`Path not found: ${searchPath}`);
    }

    return new Promise((resolveFn, rejectFn) => {
      if (signal?.aborted) { rejectFn(new Error("Operation aborted")); return; }

      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      // Request one extra context line for hash computation of the outermost
      // displayed context lines (need prev/next neighbors).
      const rgContext = agentContext + 1;

      const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
      if (ignoreCase) args.push("--ignore-case");
      if (literal) args.push("--fixed-strings");
      if (glob) args.push("--glob", glob);
      if (rgContext > 0) args.push("--context", String(rgContext));
      args.push("--", pattern, searchPath);

      const child = spawn(rgExe, args, { stdio: ["ignore", "pipe", "pipe"] });
      const rl = createInterface({ input: child.stdout });
      let stderr = "";
      let matchLimitReached = false;
      let linesTruncated = false;
      let aborted = false;
      let killedDueToLimit = false;

      const cleanup = () => { rl.close(); signal?.removeEventListener("abort", onAbort); };
      const stopChild = (dueToLimit = false) => { if (!child.killed) { killedDueToLimit = dueToLimit; child.kill(); } };
      const onAbort = () => { aborted = true; stopChild(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

      // Per-file: collect lines with their numbers and match status.
      // rg merges overlapping context windows — each line appears once.
      const fileEntries = new Map<string, LineEntry[]>();
      let currentFile = "";
      let isFirstLine = true;

      rl.on("line", (raw) => {
        if (!raw.trim()) return;
        let event: any;
        try { event = JSON.parse(raw); } catch { return; }

        if (event.type === "begin") {
          currentFile = event.data?.path?.text ?? "";
          fileEntries.set(currentFile, []);
          isFirstLine = true;
        } else if (event.type === "match" || event.type === "context") {
          const num = event.data?.line_number;
          const text = event.data?.lines?.text ?? "";
          if (!num || !text) return;

          const normalized = normalizeRgLine(text, isFirstLine);
          isFirstLine = false;

          const entries = fileEntries.get(currentFile);
          if (!entries) return;

          const existing = entries.find(e => e.lineNumber === num);
          const isMatch = event.type === "match" || (existing?.isMatch ?? false);
          if (existing) {
            existing.isMatch = isMatch;
          } else {
            entries.push({ lineNumber: num, text: normalized, isMatch });
          }

          if (event.type === "match") {
            const matchCount = entries.filter(e => e.isMatch).length;
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              stopChild(true);
            }
          }
        }
      });

      child.on("error", (error) => {
        cleanup();
        settle(() => rejectFn(new Error(`Failed to run ripgrep: ${error.message}`)));
      });

      child.on("close", () => {
        cleanup();
        if (aborted) { settle(() => rejectFn(new Error("Operation aborted"))); return; }
        if (!killedDueToLimit && child.exitCode !== 0 && child.exitCode !== 1) {
          settle(() => rejectFn(new Error(stderr.trim() || `ripgrep exited with code ${child.exitCode}`)));
          return;
        }

        // Build output
        const outputLines: string[] = [];
        const notices: string[] = [];

        for (const [filePath, entries] of fileEntries) {
          if (!entries.length) continue;
          entries.sort((a, b) => a.lineNumber - b.lineNumber);

          const relativePath = formatPath(filePath, searchPath, isDirectory);
          outputLines.push(`\n${relativePath}`);

          // Build lineNumber → {text, isMatch} map for neighbor lookup
          const lineMap = new Map(entries.map(e => [e.lineNumber, { text: e.text, isMatch: e.isMatch }]));

          // Collect match lines and build display ranges
          const matchNums = entries.filter(e => e.isMatch).map(e => e.lineNumber);
          const minLine = entries[0]!.lineNumber;
          const maxLine = entries[entries.length - 1]!.lineNumber;

          const displayRanges = matchNums.map(n => ({
            start: agentContext > 0 ? Math.max(minLine, n - agentContext) : n,
            end: agentContext > 0 ? Math.min(maxLine, n + agentContext) : n,
          }));

          const merged = mergeRanges(displayRanges);

          for (const range of merged) {
            for (let cur = range.start; cur <= range.end; cur++) {
              const entry = lineMap.get(cur);
              if (!entry) continue;
              const { text: lineText, truncated } = truncateLine(entry.text);
              if (truncated) linesTruncated = true;

              const prev = lineMap.get(cur - 1)?.text ?? "";
              const next = lineMap.get(cur + 1)?.text ?? "";
              const hash = computeHashFromContext(prev, lineText, next);

              outputLines.push(`  ${String(cur).padStart(4)}#${hash}│${lineText}`);
            }
            outputLines.push(""); // blank between blocks
          }
        }

        while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
          outputLines.pop();
        }

        let output = outputLines.join("\n");
        if (!output) {
          settle(() => resolveFn({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
          return;
        }

        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS);
          notices.push("50KB limit reached");
        }
        if (matchLimitReached) {
          notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        }
        if (linesTruncated) {
          notices.push(`Some lines truncated to ${MAX_LINE_CHARS} chars. Use read tool to see full lines`);
        }

        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        settle(() => resolveFn({ content: [{ type: "text", text: output }], details: undefined }));
      });
    });
  },
};

function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

export function registerGrepTool(pi: ExtensionAPI): void {
  if (!rgPath) return;
  pi.registerTool(grepToolDefinition);
}
