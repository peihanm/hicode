import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {createRequire} from "node:module";
import {isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import type {PillarStorageLayout} from "../persistence/index.js";

const require = createRequire(import.meta.url);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SERVERS = 32;

export interface LspServerConfig {
    command: string;
    args: string[];
    extensions: string[];
    workspaceFolder?: string;
}

export type LspConfigSource = "user";

export type LspConfig = Record<string, LspServerConfig>;

const serverSchema = z.object({
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(16_384)).max(128).optional().default([]),
    extensions: z.array(
        z.string().min(2).max(32).regex(/^\.[A-Za-z0-9][A-Za-z0-9.+_-]*$/)
    ).min(1).max(32),
    workspaceFolder: z.string().trim().min(1).max(16_384).optional(),
}).strict();

function safeResolve(specifier: string): string | undefined {
    try {
        return require.resolve(specifier);
    } catch {
        return undefined;
    }
}

function builtinConfig(): LspConfig {
    const pyrightPath = safeResolve("pyright/langserver.index.js");
    const tsLspPath = safeResolve("typescript-language-server/lib/cli.mjs");
    const nodeCommand = "node";
    const userInfoPatch = fileURLToPath(
        new URL("./userInfoPatch.cjs", import.meta.url)
    );
    const config: LspConfig = {};
    if (pyrightPath) {
        config.pyright = {
            command: nodeCommand,
            args: ["--require", userInfoPatch, pyrightPath, "--stdio"],
            extensions: [".py", ".pyi"],
        };
    }
    if (tsLspPath) {
        config["typescript-language-server"] = {
            command: nodeCommand,
            args: ["--require", userInfoPatch, tsLspPath, "--stdio"],
            extensions: [
                ".ts", ".tsx", ".mts", ".cts",
                ".js", ".jsx", ".mjs", ".cjs",
            ],
        };
    }
    return config;
}

function isMissing(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        ((error as {code?: string}).code === "ENOENT" ||
            (error as {code?: string}).code === "ENOTDIR")
    );
}

async function readUserConfig(path: string, cwd: string): Promise<LspConfig> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (isMissing(error)) return {};
        return {};
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) return {};
        const buffer = Buffer.alloc(metadata.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const {bytesRead} = await handle.read(
                buffer,
                offset,
                buffer.length - offset,
                offset
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > MAX_CONFIG_BYTES) return {};
        const text = new TextDecoder("utf-8", {fatal: true}).decode(
            buffer.subarray(0, offset)
        );
        const raw: unknown = JSON.parse(text);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const entries = Object.entries(raw as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, MAX_SERVERS);
        const config: LspConfig = {};
        for (const [name, value] of entries) {
            if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
            const parsed = serverSchema.safeParse(value);
            if (!parsed.success) continue;
            const workspaceFolder = parsed.data.workspaceFolder
                ? resolve(cwd, parsed.data.workspaceFolder)
                : undefined;
            const relativeWorkspace = workspaceFolder
                ? relative(resolve(cwd), workspaceFolder)
                : "";
            if (
                workspaceFolder &&
                (relativeWorkspace === ".." ||
                    relativeWorkspace.startsWith(`..${sep}`) ||
                    isAbsolute(relativeWorkspace))
            ) continue;
            config[name] = {
                ...parsed.data,
                extensions: [...new Set(
                    parsed.data.extensions.map((extension) =>
                        extension.toLowerCase()
                    )
                )],
                ...(workspaceFolder ? {workspaceFolder} : {}),
            };
        }
        return config;
    } catch {
        return {};
    } finally {
        await handle.close();
    }
}

export async function loadLspConfig(
    storage: PillarStorageLayout,
    cwd: string,
    sources: readonly LspConfigSource[] = ["user"]
): Promise<LspConfig> {
    const userConfig = sources.includes("user")
        ? await readUserConfig(join(storage.pillarHome, "lsp.json"), cwd)
        : {};
    return {...builtinConfig(), ...userConfig};
}
