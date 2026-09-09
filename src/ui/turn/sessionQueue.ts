import type {SaveSessionSnapshotInput} from "../../session/index.js";

export type SessionSnapshotWriter = (
    snapshot: SaveSessionSnapshotInput
) => Promise<void>;

export type SessionPersistenceErrorHandler = (error: unknown) => void;

function errorFingerprint(error: unknown): string {
    if (error instanceof Error) return `${error.name}:${error.message}`;
    return String(error);
}

/** UI 内的 best-effort 串行保存队列；可靠性策略仍由 Session storage 负责。 */
export class SessionSnapshotQueue {
    private pending: Promise<void> = Promise.resolve();
    private lastErrorFingerprint: string | null = null;

    constructor(
        private readonly writeSnapshot: SessionSnapshotWriter,
        private readonly onError?: SessionPersistenceErrorHandler
    ) {
    }

    private cloneSnapshot(
        input: SaveSessionSnapshotInput
    ): SaveSessionSnapshotInput {
        return {
            ...input,
            history: [...input.history],
            todos: [...input.todos],
            compactState: input.compactState ? {...input.compactState} : undefined,
            toolDiscovery: input.toolDiscovery
                ? {
                    version: 2,
                    loadedNames: [...input.toolDiscovery.loadedNames],
                }
                : undefined,
            uiEvents: input.uiEvents ? [...input.uiEvents] : undefined,
        };
    }

    private reportError(error: unknown): void {
        const fingerprint = errorFingerprint(error);
        if (fingerprint === this.lastErrorFingerprint) return;
        this.lastErrorFingerprint = fingerprint;
        try {
            this.onError?.(error);
        } catch {
            // UI diagnostics must not break the persistence queue.
        }
    }

    enqueue(input: SaveSessionSnapshotInput): Promise<void> {
        const snapshot = this.cloneSnapshot(input);
        const next = this.pending.then(async () => {
            try {
                await this.writeSnapshot(snapshot);
                this.lastErrorFingerprint = null;
            } catch (error) {
                this.reportError(error);
            }
        });
        this.pending = next;
        return next;
    }

    /** 需要传播保存失败的操作使用：保持串行，但把持久化失败交还调用方。 */
    enqueueCritical(input: SaveSessionSnapshotInput): Promise<void> {
        const snapshot = this.cloneSnapshot(input);
        const operation = this.pending.then(async () => {
            await this.writeSnapshot(snapshot);
            this.lastErrorFingerprint = null;
        });
        this.pending = operation.catch((error) => {
            this.reportError(error);
        });
        return operation;
    }

    drain(): Promise<void> {
        return this.pending;
    }
}
