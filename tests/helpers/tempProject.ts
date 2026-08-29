import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempProject<T>(
  run: (cwd: string) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pillar-test-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
