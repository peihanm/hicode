import {readFile} from "node:fs/promises";
import {writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {defineHiCodeTool, loadHiCodeHostConfig, HiCode} from "hicode-core-sdk";
import {z} from "zod";

const [workspace, hicodeHome] = process.argv.slice(2);
if (!workspace || !hicodeHome) {
    throw new Error("expected workspace and hicodeHome arguments");
}

let requestCount = 0;
let sawHostToolResult = false;
let sawGlobResult = false;
let sawGrepResult = false;
let sawImageResult = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions" || request.method !== "POST") {
        throw new Error(`unexpected fixture request: ${request.method} ${request.url}`);
    }
    const body = await request.text();
    requestCount += 1;
    if (requestCount === 1 && !body.includes("data:image/png;base64,")) throw new Error("SDK user attachment pixels missing");
    if (requestCount === 2) {
        sawHostToolResult = body.includes("HOST_TOOL_SENTINEL:package-smoke");
    }
    if (requestCount === 3) sawGlobResult = body.includes("fixture.ts");
    if (requestCount === 4) sawImageResult = body.includes("data:image/png;base64,") && body.includes('"tool_call_id":"sdk-package-image"');

    if (requestCount === 5) sawGrepResult = body.includes("fixture.ts:1:export const fixture = true;");

    const event = requestCount === 1
        ? {
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "sdk-package-host-lookup",
                        type: "function",
                        function: {
                            name: "host_lookup",
                            arguments: JSON.stringify({
                                key: "package-smoke",
                            }),
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
            },
        }
        : requestCount === 2
        ? {
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: "sdk-package-glob",
                        type: "function",
                        function: {
                            name: "bash",
                            arguments: JSON.stringify({
                                command: "rg --files -g '*.ts' .",
                            }),
                        },
                    }],
                },
                finish_reason: "tool_calls",
            }],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 2,
                total_tokens: 14,
            },
        }
        : requestCount === 3
        ? {choices: [{delta: {tool_calls: [{index: 0, id: "sdk-package-image", type: "function",
            function: {name: "view_image", arguments: JSON.stringify({path: "image.png"})}}]}, finish_reason: "tool_calls"}]}
        : requestCount === 4
        ? {choices: [{delta: {tool_calls: [{index: 0, id: "sdk-package-grep", type: "function",
            function: {name: "bash", arguments: JSON.stringify({command: "rg -n -H -e fixture fixture.ts"})}}]}, finish_reason: "tool_calls"}]}
        : {
            choices: [{
                delta: {
                    content: sawHostToolResult && sawGlobResult && sawImageResult && sawGrepResult
                        ? "SDK_PACKAGE_AGENT_OK"
                        : "SDK_PACKAGE_TOOL_RESULT_MISSING",
                },
                finish_reason: "stop",
            }],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
            },
        };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        headers: {"content-type": "text/event-stream"},
    });
};

process.env.HICODE_SDK_SMOKE_KEY = "offline-fixture-key";
await writeFile(resolve(workspace, "fixture.ts"), "export const fixture = true;\n");
await writeFile(resolve(workspace, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXJUsCAFpeH+EjhPzsAAAAAElFTkSuQmCC", "base64"));
let hicode;
let hostToolCalls = 0;
try {
    const loaded = loadHiCodeHostConfig({
        cwd: resolve(workspace),
        hicodeHome: resolve(hicodeHome),
        workspaceBoundary: resolve(workspace),
        fileSources: {
            settings: [],
            instructions: [],
            skills: [],
            agents: [],
            mcp: [],
        },
        settingsOverrides: {
            sources: {
                qwen: {
                    label: "SDK package fixture",
                    apiKeyEnv: "HICODE_SDK_SMOKE_KEY",
                    baseUrl: "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                    models: [{id: "qwen3.8-flash", label: "Fixture model"}],
                },
            },
            models: {
                primary: {source: "qwen", model: "qwen3.8-flash"},
                fast: {source: "qwen", model: "qwen3.8-flash"},
            },

            memory: {enabled: false},
        },
    });
    hicode = await HiCode.create({
        configuration: loaded.configuration,
        tools: [defineHiCodeTool({
            name: "host_lookup",
            description: "Look up a value owned by the SDK Host",
            parameters: z.object({key: z.string()}),
            readOnly: true,
            concurrencySafe: true,
            execute({key}, context) {
                hostToolCalls += 1;
                if (
                    context.cwd !== resolve(workspace) ||
                    context.toolCallId !== "sdk-package-host-lookup" ||
                    !context.threadId ||
                    context.signal.aborted
                ) {
                    throw new Error("Host Tool context mismatch");
                }
                return `HOST_TOOL_SENTINEL:${key}`;
            },
        })],
        host: {
            onInteraction: async () => ({
                behavior: "deny",
                message: "package smoke does not allow interactions",
            }),
        },
    });
    const thread = await hicode.startThread();
    const result = await thread.run([{type: "text", text: "Use host_lookup, then glob TypeScript files, then view image.png and grep fixture.ts for fixture."},
        {type: "image", data: await readFile(resolve(workspace, "image.png"))}], {
        maxIterations: 5,
    });
    const hostLookup = result.items.find((item) =>
        item.type === "tool_call" && item.name === "host_lookup"
    );
    const glob = result.items.find((item) =>
        item.type === "tool_call" && item.name === "bash" && item.arguments.command.startsWith("rg --files")
    );
    if (
        result.finalResponse !== "SDK_PACKAGE_AGENT_OK" ||
        requestCount !== 5 ||
        hostToolCalls !== 1 ||
        !sawHostToolResult ||
        !sawGlobResult ||
        !sawImageResult ||
        !sawGrepResult ||
        !hostLookup ||
        hostLookup.status !== "completed" ||
        hostLookup.outcome !== "ok" ||
        !hostLookup.resultPreview?.includes("HOST_TOOL_SENTINEL:package-smoke") ||
        !glob ||
        glob.status !== "completed" ||
        glob.outcome !== "ok" ||
        !glob.resultPreview?.includes("fixture.ts")
    ) {
        throw new Error(`unexpected SDK result: ${JSON.stringify({
            finalResponse: result.finalResponse,
            requestCount,
            hostToolCalls,
            sawHostToolResult,
            sawGlobResult,
            hostLookup,
            glob,
        })}`);
    }
    const image = result.items.find(item => item.type === "tool_call" && item.name === "view_image");
    if (image?.outcome !== "ok" || JSON.stringify(result).includes("base64,")) throw new Error("SDK image result missing or contains pixels in events");
    const runtime = typeof globalThis.Bun === "undefined" ? "node" : "bun";
    console.log(`SDK_PACKAGE_RUN_OK:${runtime}`);
} finally {
    try { await hicode?.close(); }
    finally { globalThis.fetch = originalFetch; }
}
