import {createHash} from "node:crypto";

const INVALID_NAME_CHARS = /[^A-Za-z0-9_]/g;
const REPEATED_UNDERSCORES = /_+/g;
const MAX_TOOL_NAME_CHARS = 64;

export function normalizeMcpName(name: string): string {
    return name.replace(INVALID_NAME_CHARS, "_").replace(REPEATED_UNDERSCORES, "_");
}

export function buildMcpToolName(serverName: string, toolName: string): string {
    const base = `mcp__${normalizeMcpName(serverName) || "server"}__${normalizeMcpName(toolName) || "tool"}`;
    if (base.length <= MAX_TOOL_NAME_CHARS) return base;
    const digest = createHash("sha256").update(base).digest("hex").slice(0, 8);
    return `${base.slice(0, MAX_TOOL_NAME_CHARS - digest.length - 1)}_${digest}`;
}

export function validateMcpServerName(name: string): boolean {
    return /^[A-Za-z0-9_.-]+$/.test(name);
}
