import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createPillarStorageLayout, type PillarStorageLayout} from "../../src/persistence/index.js";

export function createTestStorage(
  cwd: string,
  name = ".pillar-test-storage"
): PillarStorageLayout {
  return createPillarStorageLayout({pillarHome: join(cwd, name)});
}

export async function withTempProject<T>(
  run: (cwd: string, storage: PillarStorageLayout) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pillar-test-"));
  try {
    return await run(cwd, createTestStorage(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
