import {randomUUID} from "node:crypto";
import type {AgentEvent} from "./types.js";
import type {LLMTextUpdate} from "../llm/types.js";

const PREVIEW_CHARS = 200_000;
const PUBLISH_INTERVAL_MS = 80;

export class ResponseDraft {
    private id: string | undefined;
    private text = "";
    private characters = 0;
    private lastPublished = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private publication: Promise<void> | undefined;

    constructor(private readonly emit: (event: AgentEvent) => void | Promise<void>) {}

    update = async (update: LLMTextUpdate): Promise<void> => {
        if (update.type === "reset") {
            await this.finish("discarded");
            return;
        }
        await this.drain();
        this.id ??= randomUUID();
        const available = Math.max(0, PREVIEW_CHARS - this.characters);
        this.characters += update.text.length;
        this.text += update.text.slice(0, available);
        if (this.characters > PREVIEW_CHARS && /[\uD800-\uDBFF]$/.test(this.text)) this.text = this.text.slice(0, -1);
        const remaining = PUBLISH_INTERVAL_MS - (Date.now() - this.lastPublished);
        if (remaining <= 0) {
            this.cancelTimer();
            this.publication = this.publish();
            await this.drain();
        } else if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.publication = this.publish();
                // Retain failures for update/finish to consume; never leave a detached rejection.
                void this.publication.catch(() => {});
            }, remaining);
            this.timer.unref?.();
        }
    };

    private cancelTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private async publish(): Promise<void> {
        if (!this.id) return;
        this.lastPublished = Date.now();
        await this.emit({type: "assistant_draft", responseId: this.id, text: this.text, truncated: this.characters > this.text.length});
    }

    private async drain(): Promise<void> {
        const publication = this.publication;
        try { await publication; }
        finally { if (this.publication === publication) this.publication = undefined; }
    }

    async finish(disposition: "committed" | "discarded"): Promise<string | undefined> {
        this.cancelTimer();
        const id = this.id;
        try { await this.drain(); }
        finally {
            this.id = undefined;
            this.text = "";
            this.characters = 0;
            this.lastPublished = 0;
            if (id) await this.emit({type: "assistant_draft_end", responseId: id, disposition});
        }
        return id;
    }
}
