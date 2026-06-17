import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "../src/edit";
import { setCurrentTurn } from "../src/undo";

export default function (pi: ExtensionAPI): void {
  registerEditTool(pi);

  pi.on("turn_start", async (event) => {
    setCurrentTurn(event.turnIndex);
  });

  if (process.env.PI_HASHLINE_DEBUG === "1" || process.env.PI_HASHLINE_DEBUG === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
