import {describe, expect, test} from "bun:test";
import {z} from "zod";
import type {OpenAITool} from "../../src/llm/types.js";
import {
    buildToolSearchDocument,
    createToolSearchIndex,
    tokenizeToolSearchText,
} from "../../src/tools/toolSearch/searchIndex.js";
import {selectToolSearchDocuments} from "../../src/tools/toolSearch/toolSearch.js";
import type {Tool} from "../../src/tools/types.js";

function documentFor(
    name: string,
    description: string,
    parameterDescription: string,
    serverName?: string
) {
    const tool: Tool = {
        name,
        description,
        parameters: z.object({value: z.string()}),
        ...(serverName ? {mcp: {serverName}} : {}),
        isReadOnly: () => true,
        execute: async () => "ok",
    };
    const schema: OpenAITool = {
        type: "function",
        function: {
            name,
            description,
            parameters: {
                type: "object",
                properties: {
                    value: {
                        type: "string",
                        description: parameterDescription,
                    },
                },
            },
        },
    };
    return buildToolSearchDocument(tool, schema);
}

describe("tool search", () => {
    test("tokenizer 拆分 identifier 并为中文生成二元词", () => {
        expect(tokenizeToolSearchText("GitHub_createIssue 文件目录"))
            .toEqual(expect.arrayContaining([
                "git",
                "hub",
                "create",
                "issue",
                "文件目录",
                "文件",
                "件目",
                "目录",
            ]));
    });

    test("BM25 会检索名称、Server 和参数描述并保持稳定排序", () => {
        const index = createToolSearchIndex([
            documentFor(
                "mcp__files__allowed_directories",
                "List filesystem roots",
                "返回允许访问的文件目录",
                "filesystem permission roots"
            ),
            documentFor(
                "mcp__issues__list",
                "List project issues",
                "issue state filter"
            ),
        ]);
        expect(index.search("允许访问目录", 8)[0]?.document.name)
            .toBe("mcp__files__allowed_directories");
        expect(index.search("permission roots", 8)[0]?.document.name)
            .toBe("mcp__files__allowed_directories");
    });

    test("工具名命中优先于只在说明中命中", () => {
        const index = createToolSearchIndex([
            documentFor("mcp__calendar__list_events", "List events", "range"),
            documentFor(
                "mcp__workspace__lookup",
                "Search calendar calendar calendar records",
                "calendar calendar filter"
            ),
        ]);
        expect(index.search("calendar", 8)[0]?.document.name)
            .toBe("mcp__calendar__list_events");
    });

    test("names 精确匹配、去重并报告缺失名称", () => {
        const index = createToolSearchIndex([
            documentFor("mcp__fixture__echo", "Echo", "message"),
        ]);
        const selection = selectToolSearchDocuments(
            index,
            {names: ["mcp__fixture__echo", "mcp__fixture__echo", "missing"]}
        );
        expect(selection.matches.map((item) => item.name)).toEqual([
            "mcp__fixture__echo",
        ]);
        expect(selection.missingNames).toEqual(["missing"]);
    });
});
