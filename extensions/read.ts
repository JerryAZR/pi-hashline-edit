import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "../src/read";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
}
