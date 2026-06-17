import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("tool-usage", {
    description: "Show tool call counts in the current session",
    handler: async (_args, ctx) => {
      const counts = new Map<string, number>();
      let totalCalls = 0;

      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = (entry as any).message;
        if (!msg?.content || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "toolCall" && block.name) {
            counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
            totalCalls++;
          }
        }
      }

      if (totalCalls === 0) {
        ctx.ui.notify("No tool calls yet in this session.", "info");
        return;
      }

      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const lines = [`${totalCalls} total calls (${counts.size} tools):`];
      for (const [name, count] of sorted) {
        lines.push(`  ${name.padEnd(10)} ${count > 0 ? count : "—"}`);
      }

      // Also show our active tools at zero
      const ourTools = pi.getAllTools().filter(
        (t) => (t as any).sourceInfo?.packageName === "@jerryan/pi-hashline-edit"
      );
      const unusedOurTools = ourTools.filter((t) => !counts.has(t.name));
      if (unusedOurTools.length > 0) {
        lines.push("");
        lines.push("Our tools with zero calls:");
        for (const t of unusedOurTools) {
          lines.push(`  ${t.name}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
