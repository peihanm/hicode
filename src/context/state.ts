import type {SessionArchiveRecord} from "../session/archiveSchema.js";

export interface CompactState {
    consecutiveFailures: number;
    compactCount: number;
    lastCompactAt?: string;
    archives?: SessionArchiveRecord[];
}

export function createCompactState(): CompactState {
    return {
        consecutiveFailures: 0,
        compactCount: 0,
    };
}
