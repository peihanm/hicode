import {join} from "node:path";
import {createPillarStorageLayout} from "../../src/persistence/index.js";
import {ToolResultStore} from "../../src/toolResults/store.js";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_SESSION_ARTIFACT_BYTES,
  DEFAULT_PREVIEW_CHARS,
  type ToolResultStoreLimits,
} from "../../src/toolResults/types.js";

export interface TestToolResultStoreOptions extends Partial<ToolResultStoreLimits> {
  pillarHome?: string;
}

export function createTestToolResultStore(
  cwd: string,
  sessionId: string,
  options: TestToolResultStoreOptions = {}
) {
  const {
    pillarHome = join(cwd, ".pillar-test-tool-results"),
    ...storeOptions
  } = options;
  return new ToolResultStore(
    createPillarStorageLayout({pillarHome}),
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
