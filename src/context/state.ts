export interface CompactState {
    consecutiveFailures: number;
    compactCount: number;
    lastCompactAt?: string;
}

export function createCompactState(): CompactState {
    return {
        consecutiveFailures: 0,
        compactCount: 0,
    };
}
