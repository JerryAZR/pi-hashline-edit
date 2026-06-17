import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInsertTool } from "../src/insert";

export default function (pi: ExtensionAPI): void {
  registerInsertTool(pi);
}
