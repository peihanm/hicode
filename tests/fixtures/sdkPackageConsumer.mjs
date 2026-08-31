import {createServer} from "node:http";
import {writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {definePillarTool, loadPillarHostConfig, Pillar} from "pillar-core-sdk";
import {z} from "zod";

const [workspace, pillarHome] = process.argv.slice(2);
if (!workspace || !pillarHome) {
    throw new Error("expected workspace and pillarHome arguments");
}

let requestCount = 0;
let sawHostToolResult = false;
let sawGlobResult = false;
const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requestCount += 1;
    if (requestCount === 2) {
        sawHostToolResult = body.includes("HOST_TOOL_SENTINEL:package-smoke");
    }
    if (requestCount === 3) sawGlobResult = body.includes("fixture.ts");

    response.writeHead(200, {"content-type": "text/event-stream"});
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
                            name: "glob",
                            arguments: JSON.stringify({
                                pattern: "**/*.ts",
                                path: ".",
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
        : {
            choices: [{
                delta: {
                    content: sawHostToolResult && sawGlobResult
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
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
});

await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (!address || typeof address === "string") {
    throw new Error("failed to resolve fixture server address");
}

process.env.PILLAR_SDK_SMOKE_KEY = "offline-fixture-key";
await writeFile(resolve(workspace, "fixture.ts"), "export const fixture = true;\n");
let pillar;
let hostToolCalls = 0;
try {
    const loaded = loadPillarHostConfig({
        cwd: resolve(workspace),
        pillarHome: resolve(pillarHome),
        workspaceBoundary: resolve(workspace),
        fileSources: {
            settings: [],
            instructions: [],
            skills: [],
            agents: [],
            mcp: [],
            lsp: [],
        },
        settingsOverrides: {
            sources: {
                qwen: {
                    label: "SDK package fixture",
                    apiKeyEnv: "PILLAR_SDK_SMOKE_KEY",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    models: [{id: "qwen3.6-flash", label: "Fixture model"}],
                },
            },
            models: {
                primary: {source: "qwen", model: "qwen3.6-flash"},
                fast: {source: "qwen", model: "qwen3.6-flash"},
            },
            sandbox: {enabled: false},
            memory: {enabled: false},
        },
    });
    pillar = await Pillar.create({
        configuration: loaded.configuration,
        tools: [definePillarTool({
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
    const thread = await pillar.startThread();
    const result = await thread.run("Use host_lookup, then glob TypeScript files.", {
        maxIterations: 4,
    });
    const hostLookup = result.items.find((item) =>
        item.type === "tool_call" && item.name === "host_lookup"
    );
    const glob = result.items.find((item) =>
        item.type === "tool_call" && item.name === "glob"
    );
    if (
        result.finalResponse !== "SDK_PACKAGE_AGENT_OK" ||
        requestCount !== 3 ||
        hostToolCalls !== 1 ||
        !sawHostToolResult ||
        !sawGlobResult ||
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
    const runtime = typeof globalThis.Bun === "undefined" ? "node" : "bun";
    console.log(`SDK_PACKAGE_RUN_OK:${runtime}`);
} finally {
    await pillar?.close();
    await new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
    });
}
