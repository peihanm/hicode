type QueryGuardStatus = "idle" | "dispatching" | "running";

/** 同步占有 UI query，避免 React batched state 允许重复 submit。 */
export class QueryGuard {
    private statusValue: QueryGuardStatus = "idle";
    private generationValue = 0;

    reserve(): boolean {
        if (this.statusValue !== "idle") return false;
        this.statusValue = "dispatching";
        return true;
    }

    cancelReservation(): boolean {
        if (this.statusValue !== "dispatching") return false;
        this.statusValue = "idle";
        return true;
    }

    tryStart(): number | null {
        if (this.statusValue === "running") return null;
        this.statusValue = "running";
        this.generationValue += 1;
        return this.generationValue;
    }

    end(generation: number): boolean {
        if (
            this.statusValue !== "running" ||
            generation !== this.generationValue
        ) {
            return false;
        }
        this.statusValue = "idle";
        return true;
    }

}
