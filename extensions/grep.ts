import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGrepTool } from "../src/grep";

export default function (pi: ExtensionAPI): void {
  registerGrepTool(pi);
}
