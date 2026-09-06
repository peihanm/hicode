export interface TurnTimingSummary {
    durationMs: number;
    modelMs: number;
    toolMs: number;
    approvalMs: number;
    overlapMs: number;
    otherMs: number;
}

type Activity = "model" | "tool" | "approval";

/** Turn-owned wall time. Different activities overlapping occupy their own bucket. */
export class TurnTiming {
    private readonly active = {model: 0, tool: 0, approval: 0};
    private readonly totals = {modelMs: 0, toolMs: 0, approvalMs: 0, overlapMs: 0, otherMs: 0};
    private last = performance.now();
    private finished: TurnTimingSummary | undefined;

    change(activity: Activity, phase: "start" | "end"): void {
        if (this.finished) return;
        this.flush();
        this.active[activity] = Math.max(0, this.active[activity] + (phase === "start" ? 1 : -1));
    }

    async measure<T>(activity: Activity, action: () => Promise<T>): Promise<T> {
        this.change(activity, "start");
        try {
            return await action();
        } finally {
            this.change(activity, "end");
        }
    }

    finish(): TurnTimingSummary {
        if (this.finished) return this.finished;
        this.flush();
        const totals = {
            modelMs: Math.round(this.totals.modelMs),
            toolMs: Math.round(this.totals.toolMs),
            approvalMs: Math.round(this.totals.approvalMs),
            overlapMs: Math.round(this.totals.overlapMs),
            otherMs: Math.round(this.totals.otherMs),
        };
        this.finished = {...totals, durationMs: Object.values(totals).reduce((a, b) => a + b, 0)};
        return this.finished;
    }

    private flush(): void {
        const now = performance.now();
        const elapsed = Math.max(0, now - this.last);
        this.last = now;
        const kinds = Object.values(this.active).filter(count => count > 0).length;
        if (kinds > 1) this.totals.overlapMs += elapsed;
        else if (this.active.model > 0) this.totals.modelMs += elapsed;
        else if (this.active.tool > 0) this.totals.toolMs += elapsed;
        else if (this.active.approval > 0) this.totals.approvalMs += elapsed;
        else this.totals.otherMs += elapsed;
    }
}
