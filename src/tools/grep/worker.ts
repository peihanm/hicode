import {parentPort} from "node:worker_threads";
import type {SearchHit, SearchRequest, SearchResponse} from "./protocol.js";

// This worker receives already-authorized text, never filesystem or ToolContext capabilities.
function search(input: SearchRequest): SearchResponse {
    let regex: RegExp;
    try {
        regex = new RegExp(input.pattern, `${input.ignoreCase ? "i" : ""}${input.multiline ? "gms" : ""}`);
    } catch (error) {
        return {kind: "invalid_pattern", message: error instanceof Error ? error.message : String(error)};
    }
    const content = input.content;
    const hits: SearchHit[] = [];
    let count = 0;
    const record = (line: number, start: number, end: number, match: number) => {
        if (count++ >= input.offset && hits.length < input.limit) hits.push({line, start, end, match});
    };
    let line = 1;
    let start = 0;
    if (input.multiline) {
        let end = content.indexOf("\n");
        for (const match of content.matchAll(regex)) {
            while (end !== -1 && end < match.index) {
                line++;
                start = end + 1;
                end = content.indexOf("\n", start);
            }
            record(line, start, end === -1 ? content.length : end, match.index);
        }
    } else {
        while (start <= content.length) {
            const newline = content.indexOf("\n", start);
            const end = newline === -1 ? content.length : newline;
            const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
            const match = regex.exec(content.slice(start, textEnd));
            if (match) record(line, start, textEnd, start + match.index);
            if (newline === -1) break;
            start = newline + 1;
            line++;
        }
    }
    return {kind: "matches", count, hits};
}

if (!parentPort) throw new Error("Grep worker requires a parent port");
const port = parentPort;
port.on("message", (input: SearchRequest) => port.postMessage(search(input)));
