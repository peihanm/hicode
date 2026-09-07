import type {PillarStorageLayout} from "../persistence/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {createCompactState} from "../context/index.js";
import {createToolResultStore} from "../toolResults/index.js";
import {referencedResultPaths} from "../toolResults/references.js";
import {createSessionId, loadSessionTurnCheckpoint, saveSessionSnapshot} from "./storage.js";
import {readSessionEntries} from "./snapshotStore.js";
import type {FileCheckpointRuntimeLike} from "../checkpoints/types.js";
import {SessionContentStore} from "./contentStore.js";
import {archiveIndexPath} from "./archiveAccess.js";
import {prepareSessionArchive, readArchiveMessages} from "./archive.js";
import type {SessionArchiveRecord} from "./archiveSchema.js";

export interface RewindPoint {
    checkpointId: string;
    promptPreview: string;
    createdAt: string;
    capture: {kind: "available"; count: number; status: "saved" | "incomplete" | "external"} | {kind: "unavailable"};
}

export async function listRewindPoints(input: {storage: PillarStorageLayout; cwd: string; sessionId: string; runtime: FileCheckpointRuntimeLike}): Promise<RewindPoint[]> {
    const entries = readSessionEntries(input.storage, input.cwd, input.sessionId).filter(entry => entry.type === "turn_checkpoint");
    const records = await input.runtime.listCheckpoints().catch(() => []);
    const byId = new Map(records.map(record => [record.checkpointId, record]));
    return entries.reverse().map(entry => {
        const file = byId.get(entry.checkpointId);
        return {checkpointId: entry.checkpointId, promptPreview: entry.prompt.replace(/\s+/g, " ").slice(0, 200), createdAt: entry.timestamp,
            capture: file ? {kind: "available", count: file.mutations.length,
                status: file.fileCoverage === "incomplete" ? "incomplete" : file.coverageWarnings.length ? "external" : "saved"} : {kind: "unavailable"}};
    });
}

export async function forkSessionConversation(input: {
    storage: PillarStorageLayout; cwd: string; model: string; sessionId: string; checkpointId: string; permissionMode: PermissionMode;
}): Promise<{sessionId: string}> {
    const checkpoint = loadSessionTurnCheckpoint(input.storage, input.cwd, input.sessionId, input.checkpointId);
    if (!checkpoint) throw new Error("找不到对话恢复点");
    const sessionId = createSessionId();
    const source = createToolResultStore(input.storage, input.cwd, input.sessionId);
    const target = createToolResultStore(input.storage, input.cwd, sessionId);
    const replacements = new Map<string, string>();
    const sourceBlocks = new SessionContentStore(input.storage, input.cwd, input.sessionId);
    const archiveMessages = (checkpoint.compactState?.archives ?? []).map(record => readArchiveMessages(record, sourceBlocks));
    for (const path of new Set([referencedResultPaths(checkpoint.conversation), ...archiveMessages.map(referencedResultPaths)].flatMap(paths => [...paths]))) {
        const copied = await source.copyReferenceTo(path, target);
        replacements.set(path, copied.path);
    }
    const replacePaths = (text: string) => {
        for (const [from, to] of replacements) {
            text = text.replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)).replaceAll(from, to);
        }
        return text;
    };
    const replaceMessagePaths = (message: typeof checkpoint.conversation[number]) => {
        const cloned = structuredClone(message);
        if (cloned.content) cloned.content = replacePaths(cloned.content);
        if (cloned.role === "assistant") for (const call of cloned.tool_calls ?? []) call.function.arguments = replacePaths(call.function.arguments);
        return cloned;
    };
    const archives: SessionArchiveRecord[] = [];
    const targetBlocks = new SessionContentStore(input.storage, input.cwd, sessionId);
    const ids = new Set<string>();
    for (const [index, record] of (checkpoint.compactState?.archives ?? []).entries()) {
        const draft = prepareSessionArchive(input.storage, input.cwd, sessionId, archiveMessages[index]!.map(replaceMessagePaths));
        for (const value of draft.messages) ids.add(targetBlocks.stage({kind: "message", value}));
        archives.push(draft.record);
        const oldIndex = archiveIndexPath(input.storage, input.cwd, input.sessionId, record.id);
        const newIndex = archiveIndexPath(input.storage, input.cwd, sessionId, draft.record.id);
        replacements.set(oldIndex.replace(/-index\.txt$/, "-"), newIndex.replace(/-index\.txt$/, "-"));
    }
    if (ids.size) await targetBlocks.persist(ids);
    const history = checkpoint.conversation.map(replaceMessagePaths);
    history.push({role: "user", content: "<system-reminder>此会话从过去的对话位置分支，磁盘保留分支时的当前文件。历史中的文件内容、Todo 和 Task 状态可能已不适用；继续修改前重新读取。旧会话的运行中任务不属于本会话。</system-reminder>"});
    await saveSessionSnapshot(input.storage, {cwd: input.cwd, model: input.model, sessionId, history,
        todos: [], permissionMode: input.permissionMode, collaborationMode: checkpoint.collaborationMode,
        compactState: {...createCompactState(), ...(archives.length ? {archives} : {})}, uiEvents: [], toolDiscovery: checkpoint.toolDiscovery,
        queuedInputs: Buffer.byteLength(checkpoint.prompt) <= 32 * 1024
            ? [{id: createSessionId(), type: "user_input", content: checkpoint.prompt, priority: "next", createdAt: new Date().toISOString()}] : [],
        allowEmpty: true, summaryHint: checkpoint.prompt});
    return {sessionId};
}
