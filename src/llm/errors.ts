export class ContextLengthError extends Error {
    constructor() { super("Model rejected a request exceeding the context window"); this.name = "ContextLengthError"; }
}

/** Only an explicit machine code qualifies; a generic 400/message is not enough. */
export function isContextLengthResponse(status: number, text: string): boolean {
    if (status !== 400 && status !== 413) return false;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    return !!value && typeof value === "object" && "error" in value &&
        !!value.error && typeof value.error === "object" && "code" in value.error &&
        value.error.code === "context_length_exceeded";
}
