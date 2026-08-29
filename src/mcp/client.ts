import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
import type {LoadedMcpServerConfig, McpConnectedServer} from "./types.js";

const MAX_STDERR_CHARS = 64 * 1024;

function childEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
    }
    return {...env, ...extra};
}

export async function connectMcpServer(
    server: LoadedMcpServerConfig,
    cwd: string,
    signal?: AbortSignal,
    onClosed?: () => void,
    onError?: (error: Error) => void
): Promise<McpConnectedServer> {
    const transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args,
        env: childEnvironment(server.config.env),
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
        do {
            const result = await client.listTools(cursor ? {cursor} : undefined, {
                timeout: server.config.timeoutMs,
            });
            tools.push(...result.tools);
            cursor = result.nextCursor;
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
