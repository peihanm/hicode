import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
import type {LoadedMcpServerConfig, McpConnectedServer} from "./types.js";
import {
    mergeChildProcessEnvironment,
    type ChildProcessEnvironment,
} from "../runtime/childEnvironment.js";

const MAX_STDERR_CHARS = 64 * 1024;
const MAX_DISCOVERED_TOOLS = 100;
const MAX_TOOL_LIST_PAGES = 32;

export async function connectMcpServer(
    server: LoadedMcpServerConfig,
    cwd: string,
    childEnvironment: ChildProcessEnvironment,
    signal?: AbortSignal,
    onClosed?: () => void,
    onError?: (error: Error) => void
): Promise<McpConnectedServer> {
    const transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args,
        env: mergeChildProcessEnvironment(
            childEnvironment,
            server.config.env
        ) as Record<string, string>,
        cwd,
        stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
        if (stderr.length >= MAX_STDERR_CHARS) return;
        stderr += String(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    const client = new Client({name: "pillar", version: "0.1.0"});
    client.onclose = () => onClosed?.();
    client.onerror = (error) => onError?.(error);
    try {
        await client.connect(transport, {
            timeout: server.config.timeoutMs,
            signal,
        });
        const tools: McpSdkTool[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let pages = 0;
        do {
            if (pages >= MAX_TOOL_LIST_PAGES) {
                throw new Error("MCP Tools/List 分页超过安全上限");
            }
            pages += 1;
            const result = await client.listTools(cursor ? {cursor} : undefined, {
                timeout: server.config.timeoutMs,
                signal,
            });
            tools.push(...result.tools.slice(0, MAX_DISCOVERED_TOOLS - tools.length));
            if (tools.length >= MAX_DISCOVERED_TOOLS) break;
            cursor = result.nextCursor;
            if (cursor && cursors.has(cursor)) {
                throw new Error("MCP Tools/List 返回重复 cursor");
            }
            if (cursor) cursors.add(cursor);
        } while (cursor);

        let closed = false;
        return {
            config: server,
            client,
            tools,
            get stderr() {
                return stderr;
            },
            async callTool(toolName, args, signal) {
                return client.callTool(
                    {name: toolName, arguments: args},
                    undefined,
                    {signal, timeout: server.config.toolTimeoutMs, maxTotalTimeout: server.config.toolTimeoutMs}
                );
            },
            async close() {
                if (closed) return;
                closed = true;
                let completed = false;
                const closePromise = client.close().catch(() => {
                }).then(() => {
                    completed = true;
                });
                let timeout: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    closePromise,
                    new Promise<void>((resolve) => {
                        timeout = setTimeout(resolve, 2_000);
                        timeout.unref?.();
                    }),
                ]);
                if (timeout) clearTimeout(timeout);
                if (!completed) {
                    const pid = transport.pid;
                    if (pid) {
                        try {
                            process.kill(pid, "SIGTERM");
                        } catch {
                            // 进程可能已经退出。
                        }
                    }
                    await transport.close().catch(() => {
                    });
                }
            },
        };
    } catch (error) {
        await client.close().catch(() => {
        });
        const suffix = stderr.trim()
            ? `\nServer stderr captured (${stderr.trim().length} chars; hidden to avoid leaking secrets)`
            : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
}
