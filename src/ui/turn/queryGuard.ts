type QueryGuardStatus = "idle" | "dispatching" | "running";

/** Claim the UI query synchronously to prevent duplicate submissions through batched React state. */
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
