import {z} from "zod";
import type {ToolOutput} from "../toolResults/index.js";
import {DEFAULT_MAX_RESULT_CHARS} from "../toolResults/types.js";
import {schemaForTool} from "../tools/catalog.js";
import {createToolRuntime} from "../tools/registry.js";
import type {Tool} from "../tools/types.js";
import {
    PillarSDKError,
    type PillarHostTool,
    type PillarHostToolOutput,
} from "./types.js";

const MAX_HOST_TOOLS = 64;
const MAX_DESCRIPTION_CHARS = 2_048;
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_TOTAL_SCHEMA_CHARS = 512 * 1024;
const HOST_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HOST_TOOL_KEYS = new Set([
    "name",
    "description",
    "parameters",
    "readOnly",
    "concurrencySafe",
    "maxResultSizeChars",
    "execute",
]);

export function definePillarTool<TInput>(
    tool: PillarHostTool<TInput>
): PillarHostTool<TInput> {
    return tool;
}

export function adaptPillarHostTools(
    input: readonly PillarHostTool[] | undefined
): readonly Tool[] {
    if (input === undefined) return [];
    if (!Array.isArray(input)) {
        throw invalidTool("tools must be an array");
    }
    if (input.length > MAX_HOST_TOOLS) {
        throw invalidTool(`Maximum allowed: ${MAX_HOST_TOOLS} Host Tools`);
    }

    const tools: Tool[] = [];
    const names = new Set<string>();
    let totalSchemaChars = 0;
    for (const [index, candidate] of input.entries()) {
        if (!isRecord(candidate)) {
            throw invalidTool(`tools[${index}] must be an object`);
        }
        const unknownKeys = Object.keys(candidate).filter(
            (key) => !HOST_TOOL_KEYS.has(key)
        );
        if (unknownKeys.length > 0) {
            throw invalidTool(
                `tools[${index}] contains unknown fields: ${unknownKeys.join(", ")}`
            );
        }
        if (
            typeof candidate.name !== "string" ||
            !HOST_TOOL_NAME.test(candidate.name) ||
            candidate.name.startsWith("mcp__")
        ) {
            throw invalidTool(
                `tools[${index}].name must be 1–64 letters, digits or underscores, start with a letter and not use the mcp__ prefix`
            );
        }
        if (names.has(candidate.name)) {
            throw invalidTool(`Duplicate Host Tool name: ${candidate.name}`);
        }
        names.add(candidate.name);
        if (
            typeof candidate.description !== "string" ||
            candidate.description.trim().length === 0 ||
            candidate.description.length > MAX_DESCRIPTION_CHARS
        ) {
            throw invalidTool(
                `Host Tool ${candidate.name} description must contain 1–${MAX_DESCRIPTION_CHARS} characters`
            );
        }
        if (!(candidate.parameters instanceof z.ZodType)) {
            throw invalidTool(
                `Host Tool ${candidate.name} parameters must be a Zod Schema`
            );
        }
        if (typeof candidate.readOnly !== "boolean") {
            throw invalidTool(
                `Host Tool ${candidate.name} must explicitly declare readOnly`
            );
        }
        if (
            candidate.concurrencySafe !== undefined &&
            typeof candidate.concurrencySafe !== "boolean"
        ) {
            throw invalidTool(
                `Host Tool ${candidate.name} concurrencySafe must be boolean`
            );
        }
        if (candidate.concurrencySafe === true && !candidate.readOnly) {
            throw invalidTool(
                `Host Tool ${candidate.name} may declare concurrencySafe=true only when readOnly=true`
            );
        }
        const resultLimit = candidate.maxResultSizeChars;
        if (
            resultLimit !== undefined &&
            (typeof resultLimit !== "number" ||
                !Number.isSafeInteger(resultLimit) ||
                resultLimit < 1 ||
                resultLimit > DEFAULT_MAX_RESULT_CHARS)
        ) {
            throw invalidTool(
                `Host Tool ${candidate.name} maxResultSizeChars must be an integer from 1 to ${DEFAULT_MAX_RESULT_CHARS} .`
            );
        }
        if (typeof candidate.execute !== "function") {
            throw invalidTool(
                `Host Tool ${candidate.name} must provide an execute function`
            );
        }

        const name = candidate.name;
        const description = candidate.description.trim();
        const parameters = candidate.parameters;
        const readOnly = candidate.readOnly;
        const concurrencySafe = candidate.concurrencySafe === true;
        const maxResultSizeChars = resultLimit;
        const execute = candidate.execute;
        const tool: Tool<typeof parameters> = {
            name,
            description,
            parameters,
            isReadOnly: () => readOnly,
            isConcurrencySafe: () => concurrencySafe,
            ...(maxResultSizeChars === undefined
                ? {}
                : {maxResultSizeChars}),
            async execute(args, ctx, invocation): Promise<ToolOutput> {
                const output = await execute(args, Object.freeze({
                    cwd: ctx.cwd,
                    threadId: ctx.sessionId,
                    toolCallId: invocation.toolCallId,
                    signal: ctx.signal,
                }));
                return normalizeOutput(name, output);
            },
        };
        let schema: Record<string, unknown>;
        try {
            schema = schemaForTool(tool).function.parameters;
        } catch (error) {
            throw invalidTool(
                `Host Tool ${name} parameter Schema cannot be converted to JSON Schema`,
                error
            );
        }
        if (schema.type !== "object") {
            throw invalidTool(
                `Host Tool ${name} parameters must produce a top-level object JSON Schema`
            );
        }
        const schemaChars = stringifySchema(name, schema).length;
        if (schemaChars > MAX_SCHEMA_CHARS) {
            throw invalidTool(
                `Host Tool ${name} parameter Schema exceeds ${MAX_SCHEMA_CHARS} characters`
            );
        }
        totalSchemaChars += schemaChars;
        if (totalSchemaChars > MAX_TOTAL_SCHEMA_CHARS) {
            throw invalidTool(
                `Combined Host Tool parameter schemas exceed ${MAX_TOTAL_SCHEMA_CHARS} characters`
            );
        }
        tools.push(tool);
    }

    try {
        createToolRuntime({additionalTools: tools});
    } catch (error) {
        throw invalidTool(
            error instanceof Error ? error.message : String(error),
            error
        );
    }
    return tools;
}

function normalizeOutput(name: string, output: PillarHostToolOutput): ToolOutput {
    if (typeof output === "string") return output;
    if (!isRecord(output)) {
        throw new Error(`Host Tool ${name} must return a string or result object`);
    }
    const keys = Object.keys(output);
    if (keys.some((key) => key !== "content" && key !== "outcome")) {
        throw new Error(`Host Tool ${name} returned unknown result fields`);
    }
    if (typeof output.content !== "string") {
        throw new Error(`Host Tool ${name} result content must be a string`);
    }
    if (
        output.outcome !== undefined &&
        output.outcome !== "ok" &&
        output.outcome !== "failed"
    ) {
        throw new Error(`Host Tool ${name} result outcome must be ok or failed`);
    }
    return {
        content: output.content,
        ...(output.outcome === undefined ? {} : {outcome: output.outcome}),
    };
}

function stringifySchema(name: string, schema: Record<string, unknown>): string {
    try {
        return JSON.stringify(schema);
    } catch (error) {
        throw invalidTool(`Host Tool ${name} parameter Schema cannot be serialized`, error);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTool(message: string, cause?: unknown): PillarSDKError {
    return new PillarSDKError(
        "invalid_host_tool",
        message,
        cause === undefined ? undefined : {cause}
    );
}
