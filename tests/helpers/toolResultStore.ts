import {ToolResultStore} from "../../src/toolResults/store.js";
import type {ToolResultStoreOptions} from "../../src/toolResults/types.js";

export function createTestToolResultStore(
  cwd: string,
  sessionId: string,
  options: ToolResultStoreOptions = {}
) {
  return ToolResultStore.createFactory(options)(cwd, sessionId);
}
