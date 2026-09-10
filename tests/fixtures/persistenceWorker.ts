import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import { access, writeFile } from "node:fs/promises";
import { addToAllowList, type PermissionRules } from "../../src/permissions/index.js";

import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import { join } from "node:path";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

const [mode, cwd, prefix, countValue, readyPath, barrierPath] = process.argv.slice(2);
if (!mode || !cwd || !prefix || !countValue || !readyPath || !barrierPath) {
  throw new Error("persistenceWorker requires mode, cwd, prefix, count, ready and barrier");
}
const count = Number.parseInt(countValue, 10);
if (!Number.isFinite(count) || count < 1) throw new Error("invalid worker count");
const storage = createPillarStorageLayout({pillarHome: join(cwd, ".pillar-test-storage")});

await writeFile(readyPath, "ready\n", "utf8");
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

if (mode === "session") {
  for (let index = 0; index < count; index += 1) {
    await saveSessionSnapshot(storage, {
      cwd,
      model: "worker-model",
      sessionId: `${prefix}-${index}`,
      history: [
        { role: "system", content: "system" },
        { role: "user", origin: "user" as const, content: `${prefix}-task-${index}` },
      ],
      todos: [],
      permissionMode: "ask",
        collaborationMode: "build",
    });
  }
} else if (mode === "permission") {
  let rules: PermissionRules = { allow: [], ask: [], deny: [] };
  for (let index = 0; index < count; index += 1) {
    rules = await addToAllowList(`${prefix}_tool_${index}`, rules, cwd);
  }
} else if (mode === "tool-result-quota") {
  const store = createTestToolResultStore(cwd, "shared-tool-result", {
    pillarHome: join(cwd, "tool-result-artifacts"),
    maxArtifactBytes: 100,
    maxSessionBytes: 100,
  });
  const result = await store.persistText({
    toolCallId: `quota-${prefix}`,
    toolName: "worker",
    content: prefix.repeat(80),
  });
  await writeFile(`${readyPath}.result.json`, JSON.stringify(result), "utf8");
} else if (mode === "tool-result-binary") {
  const store = createTestToolResultStore(cwd, "shared-binary", {
    pillarHome: join(cwd, "tool-result-artifacts"),
  });
  const size = prefix === "a" ? 10 : 20;
  const result = await store.persistBinary({
    artifactId: "shared-artifact",
    origin: {kind: "tool", toolCallId: `binary-${prefix}`, toolName: "worker"},
    data: Buffer.alloc(size, prefix === "a" ? 1 : 2),
    mimeType: `${prefix}/type`,
  });
  await writeFile(`${readyPath}.result.json`, JSON.stringify(result), "utf8");
} else if (mode === "memory") {
  const store = new MemoryPublicationStore(storage, cwd);
  for (let index = 0; index < count; index++) {
    await store.acceptNote(`${prefix}-topic-${index}`, {operation:"remember", type:"project", content:`${prefix} content ${index}`},
      {kind:"explicit", sessionId:prefix, turnId:"turn", toolCallId:`write-${index}`}, null, new AbortController().signal);
  }
} else {
  throw new Error(`unknown persistence worker mode: ${mode}`);
}
