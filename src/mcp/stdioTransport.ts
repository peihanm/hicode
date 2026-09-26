import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {PassThrough} from "node:stream";
import {getDefaultEnvironment} from "@modelcontextprotocol/sdk/client/stdio.js";
import {ReadBuffer, serializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {Transport} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {JSONRPCMessage} from "@modelcontextprotocol/sdk/types.js";
import {createProcessTreeKiller} from "../tools/bash/process.js";

/** Own the stdio process group; the SDK still owns JSON-RPC and MCP semantics. */
export class McpStdioTransport implements Transport {
    onclose?: Transport["onclose"];
    onerror?: Transport["onerror"];
    onmessage?: Transport["onmessage"];
    readonly stderr = new PassThrough();
    private readonly buffer = new ReadBuffer();
    private readonly killTree = createProcessTreeKiller();
    private child: ChildProcessWithoutNullStreams | undefined;
    private exited: Promise<void> = Promise.resolve();
    private outputEnded: Promise<void> = Promise.resolve();
    private closing: Promise<void> | undefined;
    private started = false;

    constructor(private readonly options: {command: string; args: string[]; env: Record<string, string>; cwd: string}) {}

    async start(): Promise<void> {
        if (this.started || this.closing) throw new Error("MCP transport cannot be restarted");
        this.started = true;
        const child = spawn(this.options.command, this.options.args, {
            cwd: this.options.cwd, env: {...getDefaultEnvironment(), ...this.options.env},
            stdio: "pipe", shell: false, windowsHide: true, detached: process.platform !== "win32",
        });
        this.child = child;
        this.outputEnded = new Promise(resolve => {
            child.stdout.once("end", resolve);
            child.stdout.once("close", resolve);
        });
        this.exited = new Promise(resolve => {
            child.once("exit", () => {resolve(); void this.close();});
            child.once("error", () => {resolve(); void this.close();});
        });
        const report = (error: Error) => this.onerror?.(error);
        child.on("error", report);
        child.stdin.on("error", report);
        child.stdout.on("error", report);
        child.stderr.on("error", report);
        child.stderr.pipe(this.stderr);
        child.stdout.on("data", (chunk: Buffer) => {
            this.buffer.append(chunk);
            while (true) {
                try {
                    const message = this.buffer.readMessage();
                    if (message === null) break;
                    this.onmessage?.(message);
                } catch (error) {
                    report(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
        await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.child || this.closing) throw new Error("MCP transport is closed");
        await new Promise<void>((resolve, reject) => {
            this.child!.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
        });
    }

    close(): Promise<void> {
        this.closing ??= this.dispose();
        return this.closing;
    }

    private async dispose(): Promise<void> {
        const child = this.child;
        try {
            if (child) {
                child.stdin.end();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([this.exited, new Promise<void>(resolve => {timer = setTimeout(resolve, 1000);})]);
                } finally {clearTimeout(timer);}
                // Even a clean parent exit can leave inherited children alive.
                // Unix process groups are private to this transport, never the CLI.
                await this.killTree(child);
                // Process exit can precede the last stdout chunk. Reap inherited
                // pipe holders first, then drain the final protocol response.
                try {
                    await Promise.race([this.outputEnded, new Promise<void>(resolve => {timer = setTimeout(resolve, 250);})]);
                } finally {clearTimeout(timer);}
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            }
        } finally {
            this.child = undefined;
            this.buffer.clear();
            this.stderr.end();
            this.onclose?.();
        }
    }
}
