import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createHiCodeStorageLayout, type HiCodeStorageLayout} from "../../src/persistence/index.js";

export function createTestStorage(
  cwd: string,
  name = ".hicode-test-storage"
): HiCodeStorageLayout {
  return createHiCodeStorageLayout({hicodeHome: join(cwd, name)});
}

export async function withTempProject<T>(
  run: (cwd: string, storage: HiCodeStorageLayout) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "hicode-test-"));
  try {
    return await run(cwd, createTestStorage(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
