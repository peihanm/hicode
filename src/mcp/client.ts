import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {ToolListChangedNotificationSchema, type Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
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
    onError?: (error: Error) => void,
    onToolsChanged?: (server: McpConnectedServer | undefined) => void
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
    const client = new Client({name: "hicode", version: "0.1.0"});
    let closed = false;
    let closing: Promise<void> | undefined;
    let connected: McpConnectedServer | undefined;
    let refresh: Promise<void> | undefined;
    let dirty = false;
    client.onclose = () => { closed = true; onClosed?.(); };
    client.onerror = (error) => onError?.(error);
    const listTools = async (): Promise<McpSdkTool[]> => {
        const listSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(server.config.timeoutMs)]);
        const tools: McpSdkTool[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let pages = 0;
        do {
            if (pages >= MAX_TOOL_LIST_PAGES) {
                throw new Error("MCP Tools/List pagination exceeds the safety limit");
            }
            pages += 1;
            const result = await client.listTools(cursor ? {cursor} : undefined, {
                timeout: server.config.timeoutMs,
                signal: listSignal,
            });
            tools.push(...result.tools);
            if (tools.length > MAX_DISCOVERED_TOOLS || (tools.length === MAX_DISCOVERED_TOOLS && result.nextCursor))
                throw new Error("MCP Tools/List tool count exceeds the safety limit");
            cursor = result.nextCursor;
            if (cursor && cursors.has(cursor)) {
                throw new Error("MCP Tools/List returned a duplicate cursor");
            }
            if (cursor) cursors.add(cursor);
        } while (cursor);

        return tools;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        dirty = true;
        if (!connected || closed || refresh) return;
        onToolsChanged?.(undefined);
        refresh = (async () => {
            try {
                // Coalesce bursts, but stop a server that never settles its catalog.
                for (let attempt = 0; dirty; attempt++) {
                    if (attempt >= 3) throw new Error("MCP tool list keeps changing; reconnect explicitly");
                    dirty = false;
                    const tools = await listTools();
                    if (closed || signal?.aborted) return;
                    if (!dirty) {
                        connected!.tools = tools;
                        onToolsChanged?.(connected!);
                    }
                }
            } catch (error) {
                onError?.(error instanceof Error ? error : new Error(String(error)));
                await connected?.close();
            } finally { refresh = undefined; }
        })();
        await refresh;
    });
    try {
        await client.connect(transport, {timeout: server.config.timeoutMs, signal});
        let tools: McpSdkTool[] = [];
        for (let attempt = 0; ; attempt++) {
            if (attempt >= 3) throw new Error("Initial MCP tool list keeps changing");
            dirty = false;
            tools = await listTools();
            if (!dirty) break;
        }
        if (closed || signal?.aborted) throw new Error("MCP connection is closed");
        connected = {
            config: server,
            client,
            tools,
            get stderr() {
                return stderr;
            },
            async callTool(toolName, args, callSignal) {
                const requestSignal = AbortSignal.any([callSignal, ...(signal ? [signal] : [])]);
                if (closed || requestSignal.aborted) throw new Error("MCP connection is closed or the call was cancelled");
                return client.callTool(
                    {name: toolName, arguments: args},
                    undefined,
                    {signal: requestSignal, timeout: server.config.toolTimeoutMs, maxTotalTimeout: server.config.toolTimeoutMs}
                );
            },
            async close() {
                if (closing) return closing;
                closed = true;
                closing = (async () => {
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
                                // The process may have already exited.
                            }
                        }
                        await transport.close().catch(() => {
                        });
                    }
                })();
                return closing;
            },
        };
        return connected;
    } catch (error) {
        await client.close().catch(() => {
        });
        const suffix = stderr.trim()
            ? `\nServer stderr captured (${stderr.trim().length} chars; hidden to avoid leaking secrets)`
            : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
}
