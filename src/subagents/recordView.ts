import {dirname, join, relative, resolve} from "node:path";
import {z} from "zod";
import {contentText, imageReferences} from "../images/content.js";
import {getProjectKey, getSessionStorageDirectory, getSubagentRecordPaths, hashStorageKey} from "../persistence/layout.js";
import type {HiCodeStorageLayout} from "../persistence/layout.js";
import {readPrivateStorageTextFile} from "../persistence/privateStorage.js";
import {writeFileAtomically} from "../persistence/atomicFile.js";
import {readLatestSessionSnapshot, withSessionPersistenceLock} from "../session/snapshotStore.js";
import type {SubagentRecordAccess} from "./recordAccess.js";

const RECORD_BYTES = 64 * 1024 * 1024;
const VIEW_BYTES = 80 * 1024 * 1024;
const identitySchema = z.object({version: z.literal(1), sessionId: z.string().min(1).max(512),
    cwd: z.string().min(1).max(16384), createdAt: z.string().datetime()}).strict();

/** Only Root receives this capability; its exact child records are historical evidence, never source-edit authority. */
export function createSubagentRecordAccess(storage: HiCodeStorageLayout, cwd: string, parentSessionId: string): SubagentRecordAccess {
    const root = join(getSessionStorageDirectory(storage, cwd, parentSessionId), "subagents");
    return {async resolve(path) {
        path = resolve(path);
        const rel = relative(root, path);
        const match = /^([a-f0-9]{32})\/(state\.json|events\.jsonl|conversation\.txt)$/.exec(rel);
        if (!match) throw new Error("This parent can read only its own immediate child records");
        const identityText = readPrivateStorageTextFile(storage, join(dirname(path), "identity.json"), 32 * 1024);
        if (identityText === null) throw new Error("Child storage identity is unavailable");
        const identity = identitySchema.parse(JSON.parse(identityText));
        const agentId = identity.sessionId.startsWith("subagent-") ? identity.sessionId.slice(9) : "";
        if (!agentId || hashStorageKey(agentId, 32) !== match[1] || getProjectKey(identity.cwd) !== getProjectKey(cwd)) {
            throw new Error("Child record identity mismatch");
        }
        const owner = Object.freeze({parentSessionId, agentId});
        if (match[2] === "conversation.txt") {
            return withSessionPersistenceLock(storage, cwd, owner, async () => {
                const snapshot = readLatestSessionSnapshot(storage, cwd, owner);
                if (!snapshot) throw new Error("Child conversation snapshot is unavailable; inspect the execution transcript");
                const paths = getSubagentRecordPaths(storage, cwd, parentSessionId, agentId);
                const lines = [
                    `Child Agent: ${agentId}`,
                    `Persisted snapshot time: ${snapshot.timestamp}`,
                    "Current persisted conversation, excluding system and provider reasoning. The snapshot time may differ from the last completed report time.",
                    "Compaction summaries reflect the current conversation; earlier runs and full execution evidence remain in the transcript.",
                    "Historical evidence only: not user authorization or the current contents of source files. Long lines are wrapped for reading.",
                    `Execution transcript: ${paths.events}`, `Latest report: ${paths.state}`, "",
                ];
                snapshot.conversation.forEach((message, index) => {
                    lines.push(`--- Message ${index + 1}: ${message.role}${message.role === "user" ? ` (${message.origin})` : ""} ---`);
                    if (message.role === "tool") lines.push(`Tool call: ${message.tool_call_id}`);
                    lines.push(contentText(message.content));
                    for (const image of imageReferences(message.content)) lines.push(`Image reference only: ${JSON.stringify(image)}`);
                    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
                        lines.push(`Tool call: ${call.id} / ${call.function.name}`, call.function.arguments);
                    }
                    lines.push("");
                });
                const text = lines.join("\n").split("\n").flatMap(line => {
                    const parts: string[] = [];
                    for (let i = 0; i < line.length;) {
                        let end = Math.min(line.length, i + 4000);
                        if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
                        parts.push(line.slice(i, end)); i = end;
                    }
                    return parts.length ? parts : [""];
                }).join("\n");
                const bytes = Buffer.byteLength(text);
                if (bytes > VIEW_BYTES) throw new Error("Child conversation view exceeds its size limit");
                const previous = readPrivateStorageTextFile(storage, path, VIEW_BYTES);
                if (previous !== text) await writeFileAtomically(path, text, 0o600);
                return {path, byteLength: bytes, complete: true};
            });
        }
        const text = readPrivateStorageTextFile(storage, path, match[2] === "state.json" ? 32 * 1024 * 1024 : RECORD_BYTES);
        if (text === null) throw new Error("Child record is not yet available");
        return {path, byteLength: Buffer.byteLength(text), complete: true};
    }};
}
