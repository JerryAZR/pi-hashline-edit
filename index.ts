import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReplaceTool } from "./src/edit";
import { registerInsertTool } from "./src/insert";
import { registerReadTool } from "./src/read";
import { registerUndoTool, setCurrentTurn } from "./src/undo";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerReplaceTool(pi);
  registerInsertTool(pi);
  registerUndoTool(pi);

  const debugValue = process.env.PI_HASHLINE_DEBUG;

  // Hide the built-in edit tool so only replace/insert are visible
  pi.on("session_start", async (_event, ctx) => {
    const all = pi.getAllTools();
    const withoutEdit = all.filter(t => t.name !== "edit").map(t => t.name);
    pi.setActiveTools(withoutEdit);

    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify("Hashline Edit mode active", "info");
    }
  });
}
