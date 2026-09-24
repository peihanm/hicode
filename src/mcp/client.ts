import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {StreamableHTTPClientTransport, StreamableHTTPError} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {AsyncLocalStorage} from "node:async_hooks";
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
    const lifetime = new AbortController();
    const requestScope = new AsyncLocalStorage<AbortSignal | undefined>();
    const transport = server.config.type === "stdio"
        ? new StdioClientTransport({
            command: server.config.command,
            args: server.config.args,
            env: mergeChildProcessEnvironment(childEnvironment, server.config.env) as Record<string, string>,
            cwd, stderr: "pipe",
        })
        : new StreamableHTTPClientTransport(new URL(server.config.url), {
            reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1},
            fetch: async (url, init) => {
                const terminating = init?.method === "DELETE";
                const message: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
                const cancellation = message !== null && typeof message === "object" && "method" in message &&
                    message.method === "notifications/cancelled";
                const scopedSignal = init?.method === "POST" && !cancellation ? requestScope.getStore() : undefined;
                // DELETE is bounded cleanup even after Root cancellation. GET is a
                // connection-owned stream, never owned by the initiating tool call.
                const requestSignal = AbortSignal.any([
                    ...(init?.signal ? [init.signal] : []),
                    ...(terminating ? [AbortSignal.timeout(2000)] : [lifetime.signal, ...(signal ? [signal] : [])]),
                    ...(scopedSignal ? [scopedSignal] : []),
                    ...(init?.method === "POST" && !scopedSignal ? [AbortSignal.timeout(server.config.timeoutMs)] : []),
                ]);
                // Redirects would contact an endpoint the project did not approve.
                const response = await fetch(url, {...init, signal: requestSignal, redirect: "error"});
                if (response.ok) return response;
                await response.body?.cancel();
                if (response.status === 401 || response.status === 403) throw new StreamableHTTPError(response.status, "Authentication required");
                // The SDK includes HTTP error bodies in exceptions; servers can echo
                // credentials or sensitive request arguments there.
                return new Response(null, {status: response.status, headers: response.headers});
            },
        });
    if (transport instanceof StreamableHTTPClientTransport) {
        const send = transport.send.bind(transport);
        // Sending initialized starts the long-lived GET stream inside the SDK.
        // Detach notifications from request context so a later stream failure is
        // not mistaken for cancellation of the already finished startup request.
        transport.send = (message, options) => !Array.isArray(message) && !("id" in message)
            ? requestScope.run(undefined, () => send(message, options))
            : send(message, options);
    }
    const safeError = (error: unknown): Error => {
        if (server.config.type === "stdio") return error instanceof Error ? error : new Error(String(error));
        const status = error instanceof StreamableHTTPError ? error.code : undefined;
        return new Error(status
            ? `HTTP MCP request failed (HTTP ${status})${status === 401 || status === 403 ? "; this connection has no authentication configured" : ""}`
            : "HTTP MCP request failed or was cancelled; check the endpoint, timeout and server availability");
    };
    let stderr = "";
    if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (chunk) => {
        if (stderr.length >= MAX_STDERR_CHARS) return;
        stderr += String(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    const client = new Client({name: "hicode", version: "0.1.0"});
    let closed = false;
    let closing: Promise<void> | undefined;
    let connected: McpConnectedServer | undefined;
    let refresh: Promise<void> | undefined;
    let dirty = false;
    // Startup failures are reported by connect's rejection, not as a later
    // disconnection that would overwrite Failed with Closed in the manager.
    client.onclose = () => { closed = true; if (connected) onClosed?.(); };
    client.onerror = (error) => {
        if (lifetime.signal.aborted || signal?.aborted ||
            (server.config.type === "http" && requestScope.getStore()?.aborted)) return;
        onError?.(safeError(error));
    };
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
            const result = await requestScope.run(listSignal, () => client.listTools(cursor ? {cursor} : undefined, {
                timeout: server.config.timeoutMs,
                signal: listSignal,
            }));
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
        if (!connected || closed) return;
        onToolsChanged?.(undefined);
        if (refresh) return;
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
                onError?.(safeError(error));
                await connected?.close();
            } finally { refresh = undefined; }
        })();
        await refresh;
    });
    try {
        const startupSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(server.config.timeoutMs)]);
        await requestScope.run(startupSignal, () => client.connect(transport, {timeout: server.config.timeoutMs, signal: startupSignal}));
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
                const requestSignal = AbortSignal.any([callSignal, lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(server.config.toolTimeoutMs)]);
                if (closed || requestSignal.aborted) throw new Error("MCP connection is closed or the call was cancelled");
                return requestScope.run(requestSignal, () => client.callTool(
                    {name: toolName, arguments: args},
                    undefined,
                    {signal: requestSignal, timeout: server.config.toolTimeoutMs, maxTotalTimeout: server.config.toolTimeoutMs}
                )).catch(error => {throw safeError(error);});
            },
            async close() {
                if (closing) return closing;
                closed = true;
                closing = (async () => {
                    lifetime.abort();
                    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
                        await transport.terminateSession().catch(() => {});
                    }
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
                        const pid = transport instanceof StdioClientTransport ? transport.pid : undefined;
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
        lifetime.abort();
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
            await transport.terminateSession().catch(() => {});
        }
        await client.close().catch(() => {
        });
        const suffix = stderr.trim()
            ? `\nServer stderr captured (${stderr.trim().length} chars; hidden to avoid leaking secrets)`
            : "";
        throw new Error(`${safeError(error).message}${suffix}`);
    }
}
