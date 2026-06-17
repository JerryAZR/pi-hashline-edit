import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUndoTool } from "../src/undo";

export default function (pi: ExtensionAPI): void {
  registerUndoTool(pi);
}
