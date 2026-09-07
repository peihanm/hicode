import {resolve} from "node:path";
import type {Message} from "../llm/types.js";

/** Only framework result envelopes and known task/read receipts grant artifact access. */
export function referencedResultPaths(history: readonly Message[]): Set<string> {
    const paths = new Set<string>();
    const toolNames = new Map<string, string>();
    for (const message of history) {
        if (message.role === "assistant") for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
        if (message.role !== "tool") continue;
        const references = [...message.content.matchAll(/^<persisted-output>\n[\s\S]*?^<\/persisted-output>$/gm)]
            .flatMap(block => [...block[0].matchAll(/^(?:Full output saved|Only a partial output could be saved) at: ("(?:[^"\\\n]|\\.)*")$/gm)]);
        // MCP binary receipts can occur inside a JSON text block; parse its text before matching.
        const texts = [message.content];
        try {
            const value: unknown = JSON.parse(message.content);
            if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
                for (const block of value.content) if (block && typeof block === "object" && "text" in block && typeof block.text === "string") texts.push(block.text);
            }
        } catch { /* Plain text result. */ }
        for (const text of texts) for (const match of text.matchAll(/\[[^\n]*? saved to ([^\n]+?\/[a-f0-9]{32}\.bin); [^\n]*?; \d+ bytes(?:; truncated)?\]/g)) {
            if (match[1]!.length <= 16384) paths.add(resolve(match[1]!));
        }
        const name = toolNames.get(message.tool_call_id);
        if (name === "task" || name === "bash_task") references.push(...message.content.matchAll(/^Saved (?:output|diff): ("(?:[^"\\\n]|\\.)*")$/gm));
        else if (name === "read_file") references.push(...message.content.matchAll(/^Saved output: ("(?:[^"\\\n]|\\.)*")\n/g));
        for (const match of references) {
            try {
                const path: unknown = JSON.parse(match[1]!);
                if (typeof path === "string" && path.length > 0 && path.length <= 16384) paths.add(resolve(path));
            } catch { /* Malformed references grant no capability. */ }
        }
    }
    return paths;
}
