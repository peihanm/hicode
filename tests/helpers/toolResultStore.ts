import {
  createToolResultStoreFactory,
} from "../../src/toolResults/store.js";
import type {ToolResultStoreOptions} from "../../src/toolResults/types.js";

export function createTestToolResultStore(
  cwd: string,
  sessionId: string,
  options: ToolResultStoreOptions = {}
) {
  return createToolResultStoreFactory(options)(cwd, sessionId);
}
