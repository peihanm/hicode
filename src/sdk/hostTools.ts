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
        throw invalidTool("tools 必须是数组");
    }
    if (input.length > MAX_HOST_TOOLS) {
        throw invalidTool(`最多允许 ${MAX_HOST_TOOLS} 个 Host Tool`);
    }

    const tools: Tool[] = [];
    const names = new Set<string>();
    let totalSchemaChars = 0;
    for (const [index, candidate] of input.entries()) {
        if (!isRecord(candidate)) {
            throw invalidTool(`tools[${index}] 必须是对象`);
        }
        const unknownKeys = Object.keys(candidate).filter(
            (key) => !HOST_TOOL_KEYS.has(key)
        );
        if (unknownKeys.length > 0) {
            throw invalidTool(
                `tools[${index}] 包含未知字段: ${unknownKeys.join(", ")}`
            );
        }
        if (
            typeof candidate.name !== "string" ||
            !HOST_TOOL_NAME.test(candidate.name) ||
            candidate.name.startsWith("mcp__")
        ) {
            throw invalidTool(
                `tools[${index}].name 必须是 1-64 位字母开头的字母、数字或下划线，且不能使用 mcp__ 前缀`
            );
        }
        if (names.has(candidate.name)) {
            throw invalidTool(`重复 Host Tool 名称: ${candidate.name}`);
        }
        names.add(candidate.name);
        if (
            typeof candidate.description !== "string" ||
            candidate.description.trim().length === 0 ||
            candidate.description.length > MAX_DESCRIPTION_CHARS
        ) {
            throw invalidTool(
                `Host Tool ${candidate.name} 的 description 必须是 1-${MAX_DESCRIPTION_CHARS} 字符`
            );
        }
        if (!(candidate.parameters instanceof z.ZodType)) {
            throw invalidTool(
                `Host Tool ${candidate.name} 的 parameters 必须是 Zod Schema`
            );
        }
        if (typeof candidate.readOnly !== "boolean") {
            throw invalidTool(
                `Host Tool ${candidate.name} 必须显式声明 readOnly`
            );
        }
        if (
            candidate.concurrencySafe !== undefined &&
            typeof candidate.concurrencySafe !== "boolean"
        ) {
            throw invalidTool(
                `Host Tool ${candidate.name} 的 concurrencySafe 必须是 boolean`
            );
        }
        if (candidate.concurrencySafe === true && !candidate.readOnly) {
            throw invalidTool(
                `Host Tool ${candidate.name} 只有 readOnly=true 时才能声明 concurrencySafe=true`
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
                `Host Tool ${candidate.name} 的 maxResultSizeChars 必须是 1-${DEFAULT_MAX_RESULT_CHARS} 的整数`
            );
        }
        if (typeof candidate.execute !== "function") {
            throw invalidTool(
                `Host Tool ${candidate.name} 必须提供 execute 函数`
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
                `Host Tool ${name} 的参数 Schema 无法转换为 JSON Schema`,
                error
            );
        }
        if (schema.type !== "object") {
            throw invalidTool(
                `Host Tool ${name} 的 parameters 必须生成顶层 object JSON Schema`
            );
        }
        const schemaChars = stringifySchema(name, schema).length;
        if (schemaChars > MAX_SCHEMA_CHARS) {
            throw invalidTool(
                `Host Tool ${name} 的参数 Schema 超过 ${MAX_SCHEMA_CHARS} 字符`
            );
        }
        totalSchemaChars += schemaChars;
        if (totalSchemaChars > MAX_TOTAL_SCHEMA_CHARS) {
            throw invalidTool(
                `Host Tool 参数 Schema 合计超过 ${MAX_TOTAL_SCHEMA_CHARS} 字符`
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
        throw new Error(`Host Tool ${name} 返回值必须是字符串或结果对象`);
    }
    const keys = Object.keys(output);
    if (keys.some((key) => key !== "content" && key !== "outcome")) {
        throw new Error(`Host Tool ${name} 返回了未知结果字段`);
    }
    if (typeof output.content !== "string") {
        throw new Error(`Host Tool ${name} 返回值的 content 必须是字符串`);
    }
    if (
        output.outcome !== undefined &&
        output.outcome !== "ok" &&
        output.outcome !== "failed"
    ) {
        throw new Error(`Host Tool ${name} 返回值的 outcome 必须是 ok 或 failed`);
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
        throw invalidTool(`Host Tool ${name} 的参数 Schema 无法序列化`, error);
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
