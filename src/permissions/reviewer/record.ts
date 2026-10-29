import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {join} from "node:path";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile} from "../../persistence/privateStorage.js";
import {getApprovalReviewDirectory, hashStorageKey} from "../../persistence/layout.js";
import type {HiCodeStorageLayout} from "../../persistence/layout.js";
import {withFileLock} from "../../persistence/fileLock.js";
import {writeFileAtomically} from "../../persistence/atomicFile.js";
import type {AgentEvent} from "../../agent/types.js";
import type {LLMTrace} from "../../llm/types.js";
import type {ModelTargetSettings} from "../../settings/types.js";
import type {ApprovalRequest, ReviewVerdict} from "../approval.js";

type ReviewOutcome = {status: "completed"; verdict: ReviewVerdict} | {status: "failed" | "cancelled"};
const SUMMARY_BYTES = 16 * 1024;
const EVENT_BYTES = 4 * 1024 * 1024;

/** One reviewer owns one run. History is represented by the exact request and committed events, not copied snapshots. */
export async function createApprovalReviewRecord(
    storage: HiCodeStorageLayout, trace: LLMTrace, request: ApprovalRequest,
    model: Pick<ModelTargetSettings, "source" | "model" | "reasoning">, policy: string, startedAt: number
) {
    const root = getApprovalReviewDirectory(storage, trace.ownerCwd, trace.scope === "session" ? trace.sessionId : undefined);
    const directory = join(root, hashStorageKey(request.id, 32));
    ensurePrivateStorageDirectory(storage, root);
    await withFileLock(join(root, ".lock"), async () => {
        ensurePrivateStorageDirectory(storage, directory);
        if (readPrivateStorageTextFile(storage, join(directory, "request.json"), 128 * 1024) !== null) {
            throw new Error("Approval review ID already exists");
        }
        const {evidence, ...action} = request;
        const serializedAction = JSON.stringify(action);
        await writeFileAtomically(join(directory, "request.json"), JSON.stringify({
            version: 1, policy, model, trace, startedAt: new Date(startedAt).toISOString(),
            action: Buffer.byteLength(serializedAction) <= 64 * 1024 ? action : {
                omitted: true, reason: "Action exceeds review input budget", bytes: Buffer.byteLength(serializedAction),
                sha256: createHash("sha256").update(serializedAction).digest("hex"),
            },
            evidence: JSON.parse(evidence.text),
        }), 0o600);
    });
    let pending = Promise.resolve();
    let events = 0;
    let bytes = 0;
    let eventFailure = false;
    return {
        append(event: AgentEvent): Promise<void> {
            // Incremental draft text and token counters are replaced by committed
            // assistant/tool events; exact model responses remain in request logs.
            if (["assistant_draft", "assistant_draft_end", "model_stream_progress", "token_update"].includes(event.type)) return Promise.resolve();
            const line = JSON.stringify({timestamp: new Date().toISOString(), event}) + "\n";
            const operation = pending.then(async () => {
                const size = Buffer.byteLength(line);
                if (bytes + size > EVENT_BYTES) throw new Error("Approval event log exceeds 4 MiB");
                const handle = await open(join(directory, "events.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
                try {
                    if (!(await handle.stat()).isFile()) throw new Error("Unsafe approval event log");
                    await handle.writeFile(line); bytes += size; events++;
                } finally {await handle.close();}
            });
            pending = operation.catch(() => {eventFailure = true;});
            return operation;
        },
        async finish(toolCalls: number, modelInvoked: boolean, outcome: ReviewOutcome) {
            await pending;
            const content = JSON.stringify({
                version: 1, requestId: request.id, turnId: request.turnId, toolCallId: request.toolCallId,
                kind: request.kind, toolName: request.toolName, evidence: request.evidence.summary, model, trace,
                startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(),
                durationMs: Math.max(0, Date.now() - startedAt), toolCalls, modelInvoked,
                events, eventLogComplete: !eventFailure, ...outcome,
            }, null, 2);
            if (Buffer.byteLength(content) > SUMMARY_BYTES) throw new Error("Approval review record exceeds its budget");
            await writeFileAtomically(join(directory, "result.json"), content, 0o600);
        },
    };
}
