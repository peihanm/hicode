import {viewImageTool} from "./viewImage/viewImage.js";
import {zodToJsonSchema} from "zod-to-json-schema";
import type {OpenAITool} from "../llm/types.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../subagents/registry.js";
import {createAgentTool} from "./agent/agent.js";
import {askUserTool} from "./askUser/askUser.js";
import {bashTool} from "./bash/bash.js";
import {editFileTool} from "./editFile/editFile.js";
import {deleteFileTool} from "./deleteFile/deleteFile.js";
import {globTool} from "./glob/glob.js";
import {grepTool} from "./grep/grep.js";
import {listFilesTool} from "./listFiles/listFiles.js";
import {readFileTool} from "./readFile/readFile.js";
import {skillTool} from "./skill/skill.js";
import {taskTool} from "./task/task.js";
import {todoWriteTool} from "./todoWrite/todoWrite.js";
import {TOOL_SEARCH_NAME} from "./toolSearch/toolSearch.js";
import type {Tool, ToolExposure} from "./types.js";
import {webFetchTool} from "./webFetch/webFetch.js";
import {writeFileTool} from "./writeFile/writeFile.js";

export interface ToolRegistration {
    tool: Tool;
    exposure: ToolExposure;
    schema: () => OpenAITool;
}

export interface ToolCatalog {
    tools: Tool[];
    registrations: ToolRegistration[];
}

export interface CreateToolCatalogOptions {
    /** Root startup capability; omitted for the complete definition catalog. */
    skillsAvailable?: boolean;
    allowedToolNames?: readonly string[];
    additionalTools?: readonly Tool[];
    toolOverrides?: readonly Tool[];
}

function createBuiltinTools(): Tool[] {
    // Agent 的默认实现只用于基础 Catalog 和能力校验。Root Runtime 会用当前
    // Subagent Catalog 生成同名 override，因此这里不导出一份隐式全局 Tool。
    return [
        listFilesTool,
        readFileTool,
        viewImageTool,
        writeFileTool,
        editFileTool,
        deleteFileTool,
        grepTool,
        globTool,
        bashTool,
        askUserTool,
        todoWriteTool,
        skillTool,
        createAgentTool(BUILTIN_SUBAGENT_REGISTRY),
        taskTool,
        webFetchTool,
    ];
}

export function schemaForTool(tool: Tool): OpenAITool {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.getDescription?.() ?? tool.description,
            parameters:
                tool.inputJsonSchema ??
                (zodToJsonSchema(tool.parameters, {target: "jsonSchema7"}) as Record<
                    string,
                    unknown
                >),
        },
    };
}

function schemaSourceForTool(tool: Tool): () => OpenAITool {
    const base = schemaForTool(tool);
    if (!tool.getDescription) return () => base;
    return () => {
        const description = tool.getDescription!();
        if (description === base.function.description) return base;
        return {
            ...base,
            function: {...base.function, description},
        };
    };
}

export function createToolCatalog(
    options: CreateToolCatalogOptions
): ToolCatalog {
    const builtins = createBuiltinTools();
    const overrides = new Map(
        (options.toolOverrides ?? []).map((tool) => [tool.name, tool])
    );
    const builtinNames = new Set(builtins.map((tool) => tool.name));
    const unknownOverrides = [...overrides.keys()].filter(
        (name) => !builtinNames.has(name)
    );
    if (unknownOverrides.length > 0) {
        throw new Error(`覆盖了未知工具: ${unknownOverrides.join(", ")}`);
    }

    const combinedTools = builtins.map((tool) => overrides.get(tool.name) ?? tool);
    const names = new Set(combinedTools.map((tool) => tool.name));
    for (const tool of options.additionalTools ?? []) {
        if (tool.name === TOOL_SEARCH_NAME) {
            throw new Error(`工具名 ${TOOL_SEARCH_NAME} 由 Runtime 保留`);
        }
        if (names.has(tool.name)) {
            throw new Error(`重复工具名: ${tool.name}`);
        }
        names.add(tool.name);
        combinedTools.push(tool);
    }

    const allowed = options.allowedToolNames
        ? new Set(options.allowedToolNames)
        : null;
    if (allowed) {
        const unknown = [...allowed].filter((name) => !names.has(name));
        if (unknown.length > 0) {
            throw new Error(`Agent 配置了未知工具: ${unknown.join(", ")}`);
        }
    }
    const availableTools = options.skillsAvailable === false ? combinedTools.filter(tool => tool.name !== "skill") : combinedTools;
    const scopedTools = allowed
        ? availableTools.filter((tool) => allowed.has(tool.name))
        : availableTools;
    return {
        tools: scopedTools,
        registrations: scopedTools.map((tool) => ({
            tool,
            exposure: tool.exposure ?? "direct",
            schema: schemaSourceForTool(tool),
        })),
    };
}
