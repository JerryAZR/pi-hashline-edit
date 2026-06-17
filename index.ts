import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "./src/edit";
// import { registerInsertTool } from "./src/insert"; // opt-in: uncomment to enable insert tool
import { registerGrepTool } from "./src/grep";
import { registerReadTool } from "./src/read";
import { registerUndoTool, setCurrentTurn } from "./src/undo";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  // registerInsertTool(pi); // disabled — some models prefer edit for insertions; kept for future config opt-in
  registerGrepTool(pi);
  registerUndoTool(pi);

  pi.on("turn_start", async (event) => {
    setCurrentTurn(event.turnIndex);
  });

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
