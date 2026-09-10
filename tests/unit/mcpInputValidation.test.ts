import {expect, test} from "bun:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {adaptMcpTools} from "../../src/mcp/toolAdapter.js";
import {executeRegisteredTool} from "../../src/tools/execute.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {McpConnectedServer} from "../../src/mcp/types.js";

function fixture(inputSchema: McpConnectedServer["tools"][number]["inputSchema"]) {
    const calls: Record<string, unknown>[] = [];
    const server: McpConnectedServer = {
        config: {name: "fixture", source: "host", id: "fixture", config: {type: "stdio", command: "unused", args: [], disabled: false, timeoutMs: 1000, toolTimeoutMs: 1000}},
        client: new Client({name: "test", version: "1"}), stderr: "",
        tools: [{name: "validate", inputSchema}],
        async callTool(_name, args) {calls.push(args); return {content: [{type: "text", text: "called"}]};},
        async close() {},
    };
    return {server, calls};
}

test("MCP required/嵌套约束在远端执行之前拒绝，合法输入原样传递", async () => {
    await withTempProject(async cwd => {
        const {server, calls} = fixture({type: "object", properties: {count: {type: "integer", minimum: 1}, mode: {enum: ["safe"]}}, required: ["count"], additionalProperties: false});
        const {tools, issues} = adaptMcpTools(server);
        expect(issues).toEqual([]);
        const tool = tools[0]!;
        const map = new Map([[tool.name, tool]]);
        const ctx = createTestContext(cwd);
        for (const args of [{}, {count: "2"}, {count: 0}, {count: 2, mode: "unsafe"}, {count: 2, extra: true}]) {
            expect((await executeRegisteredTool(map, tool.name, JSON.stringify(args), ctx, "bad")).outcome).toBe("failed");
        }
        expect(calls).toEqual([]);
        expect((await executeRegisteredTool(map, tool.name, '{"count":2,"mode":"safe"}', ctx, "good")).outcome).toBe("ok");
        expect(calls).toEqual([{count: 2, mode: "safe"}]);
    });
});

test.each([
    undefined,
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
])("MCP dialect %s 完整应用本地引用、嵌套组合、数组和条件约束", dialect => {
    const {server} = fixture({type: "object", ...(dialect ? {$schema: dialect} : {}),
        definitions: {name: {type: "string", minLength: 2, pattern: "^[a-z]+$"}},
        properties: {names: {type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: {$ref: "#/definitions/name"}},
            choice: {oneOf: [{const: "a"}, {type: "integer", minimum: 1, maximum: 3}]}, flag: {type: "boolean"}, extra: {type: "string"}},
        required: ["names", "choice"], additionalProperties: false,
        if: {properties: {flag: {const: true}}, required: ["flag"]}, then: {required: ["extra"]},
    });
    const {tools, issues} = adaptMcpTools(server);
    expect(issues).toEqual([]);
    const valid = {names: ["hello"], choice: 2};
    expect(tools[0]!.parameters.safeParse(valid).success).toBe(true);
    for (const value of [
        {...valid, names: []}, {...valid, names: ["a"]}, {...valid, names: ["HELLO"]},
        {...valid, names: ["hello", "hello"]}, {...valid, choice: 4}, {...valid, flag: true},
    ]) expect(tools[0]!.parameters.safeParse(value).success).toBe(false);
});

test("2020-12 unevaluatedProperties/prefixItems/contains 不丢约束", () => {
    const {server} = fixture({type: "object", allOf: [{properties: {tuple: {type: "array", prefixItems: [{type: "string"}], items: {type: "integer"}, contains: {const: 2}, minContains: 1, maxContains: 1}}}], unevaluatedProperties: false});
    const {tools, issues} = adaptMcpTools(server);
    expect(issues).toEqual([]);
    const parse = (value: unknown) => tools[0]!.parameters.safeParse(value).success;
    expect(parse({tuple: ["ok", 2]})).toBe(true);
    for (const value of [{extra: true}, {tuple: [1, 2]}, {tuple: ["ok", 3]}, {tuple: ["ok", 2, 2]}, {tuple: ["ok", "bad", 2]}]) expect(parse(value)).toBe(false);
});

test.each([
    {$schema: "http://json-schema.org/draft-04/schema#"},
    {properties: {x: {$ref: "https://example.com/remote.json"}}},
    {properties: {x: {$ref: "#/missing"}}},
    {properties: {x: {$ref: "#/$defs/loop"}}, $defs: {loop: {$ref: "#/$defs/loop"}}},
    {properties: {x: {$dynamicRef: "#node"}}},
    {properties: {x: {type: "string", minLenght: 2}}},
    {properties: {x: {type: "string", format: "unknown-format"}}},
    {properties: {x: {type: "string", pattern: "(?=a)a"}}},
    {properties: {x: {type: "string", pattern: "["}}},
    {properties: {x: {$id: "nested", type: "string"}}},
])("不安全或不支持的 Schema 明确成为加载 issue %#", additions => {
    const {server} = fixture({type: "object", ...additions});
    const adapted = adaptMcpTools(server);
    expect(adapted.tools).toHaveLength(0);
    expect(adapted.issues[0]).toContain("inputSchema 无法加载");
});

test("安全 pattern、format 和非变异输入；编译后 Server 对象修改不改变契约", () => {
    const {server} = fixture({type: "object", properties: {text: {type: "string", pattern: "^(a+)+$"}, email: {type: "string", format: "email"}, date: {type: "string", format: "date"}, optional: {type: "integer", default: 9}}, additionalProperties: true});
    const {tools, issues} = adaptMcpTools(server);
    expect(issues).toEqual([]);
    const tool = tools[0]!;
    const value = {text: "aaa", email: "hello@example.com", date: "2024-02-29", untouched: {x: null}};
    expect(tool.parameters.parse(value)).toEqual(value);
    expect(value).not.toHaveProperty("optional");
    expect(tool.parameters.safeParse({...value, text: `${"a".repeat(30_000)}!`}).success).toBe(false);
    expect(tool.parameters.safeParse({...value, date: "2023-02-29"}).success).toBe(false);
    expect(tool.parameters.safeParse({...value, email: "bad"}).success).toBe(false);
    server.tools[0]!.inputSchema.properties = {};
    expect(tool.parameters.safeParse({...value, email: "bad"}).success).toBe(false);
});

test("Hook 最终改写后再次校验，失败不请求权限也不调用 Server", async () => {
    await withTempProject(async cwd => {
        const {server, calls} = fixture({type: "object", properties: {n: {type: "integer", minimum: 1}}, required: ["n"]});
        const tool = adaptMcpTools(server).tools[0]!;
        let approvals = 0;
        const ctx = createTestContext(cwd, {permissionMode: "ask", canUseTool: async () => {approvals++; return {behavior: "allow"};}});
        const result = await executeRegisteredTool(new Map([[tool.name, tool]]), tool.name, '{"n":2}', ctx, "hook", {enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {}, issues: [], async execute() {
            return {blocked: false, additionalContexts: [], executions: [], updatedInput: {n: 0}};
        }});
        expect(result.outcome).toBe("failed");
        expect(result.modelContent).toContain("Hook 修改后的参数校验失败");
        expect(approvals).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

test("输入与引用展开预算超限明确拒绝；超深 Schema 不影响其他工具", () => {
    const {server} = fixture({type: "object"});
    const tool = adaptMcpTools(server).tools[0]!;
    expect(tool.parameters.safeParse({text: "x".repeat(270_000)}).success).toBe(false);
    let deep: {[key: string]: object} = {};
    for (let i = 0; i < 60; i++) deep = {child: deep};
    expect(tool.parameters.safeParse(deep).success).toBe(false);
    server.tools.push({name: "deep", inputSchema: {type: "object", properties: deep}});
    expect(adaptMcpTools(server).tools).toHaveLength(1);
    const defs: Record<string, unknown> = {leaf: {type: "string"}};
    let previous = "leaf";
    for (let i = 0; i < 15; i++) {defs[`node${i}`] = {allOf: [{$ref: `#/$defs/${previous}`}, {$ref: `#/$defs/${previous}`}]}; previous = `node${i}`;}
    server.tools = [{name: "wide", inputSchema: {type: "object", $defs: defs, properties: {x: {$ref: `#/$defs/${previous}`}}}}];
    expect(adaptMcpTools(server).issues[0]).toContain("预算");
});

test("多个 patternProperties 分别执行，本地 Pointer 转义与 JSON 保留字段不丢失", () => {
    const {server} = fixture({type: "object", $defs: {"a/b~c": {type: "integer", minimum: 1}}, patternProperties: {"^a": {$ref: "#/$defs/a~1b~0c"}, "^b": {type: "string", pattern: "^ok$"}}, additionalProperties: true});
    const tool = adaptMcpTools(server).tools[0]!;
    expect(tool.parameters.safeParse({alpha: 1, beta: "ok"}).success).toBe(true);
    expect(tool.parameters.safeParse({alpha: 0}).success).toBe(false);
    expect(tool.parameters.safeParse({beta: "bad"}).success).toBe(false);
    const value: unknown = JSON.parse('{"__proto__":{"visible":true},"constructor":"preserve"}');
    expect(tool.parameters.parse(value)).toEqual(value);
    server.tools[0]!.inputSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    expect(adaptMcpTools(server).issues[0]).toContain("__proto__");
});
