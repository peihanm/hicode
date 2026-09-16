import {join} from "node:path";
import {createHiCodeStorageLayout} from "../../src/persistence/index.js";
import {ToolResultStore} from "../../src/toolResults/store.js";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_SESSION_ARTIFACT_BYTES,
  DEFAULT_PREVIEW_CHARS,
  type ToolResultStoreLimits,
} from "../../src/toolResults/types.js";

export interface TestToolResultStoreOptions extends Partial<ToolResultStoreLimits> {
  hicodeHome?: string;
}

export function createTestToolResultStore(
  cwd: string,
  sessionId: string,
  options: TestToolResultStoreOptions = {}
) {
  const {
    hicodeHome = join(cwd, ".hicode-test-tool-results"),
    ...storeOptions
  } = options;
  return new ToolResultStore(
    createHiCodeStorageLayout({hicodeHome}),
    cwd,
    sessionId,
    {
      maxArtifactBytes: storeOptions.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      maxSessionBytes:
        storeOptions.maxSessionBytes ?? DEFAULT_MAX_SESSION_ARTIFACT_BYTES,
      previewChars: storeOptions.previewChars ?? DEFAULT_PREVIEW_CHARS,
    }
  );
}
