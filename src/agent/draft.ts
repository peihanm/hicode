import {randomUUID} from "node:crypto";
import type {AgentEvent} from "./types.js";
import type {LLMTextUpdate} from "../llm/types.js";

const PREVIEW_CHARS = 8_000;

export class ResponseDraft {
    private id: string | undefined;
    private text = "";
    private characters = 0;
    private lastPublished = 0;

    constructor(private readonly emit: (event: AgentEvent) => void | Promise<void>) {}

    update = async (update: LLMTextUpdate): Promise<void> => {
        if (update.type === "reset") {
            await this.finish("discarded");
            return;
        }
        this.id ??= randomUUID();
        this.characters += update.text.length;
        this.text = (this.text + update.text).slice(-PREVIEW_CHARS);
        if (/^[\uDC00-\uDFFF]/.test(this.text)) this.text = this.text.slice(1);
        const now = Date.now();
        if (this.lastPublished && now - this.lastPublished < 80) return;
        this.lastPublished = now;
        await this.emit({type: "assistant_draft", responseId: this.id, text: this.text, truncated: this.characters > this.text.length});
    };

    async finish(disposition: "committed" | "discarded"): Promise<string | undefined> {
        const id = this.id;
        this.id = undefined;
        this.text = "";
        this.characters = 0;
        this.lastPublished = 0;
        if (id) await this.emit({type: "assistant_draft_end", responseId: id, disposition});
        return id;
    }
}
