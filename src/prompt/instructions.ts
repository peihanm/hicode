import {homedir} from "node:os";
import {Buffer} from "node:buffer";
import {dirname, isAbsolute, join, parse, relative, resolve} from "node:path";
import {constants} from "node:fs";
import {open} from "node:fs/promises";

const MAX_INSTRUCTION_FILE_CHARS = 40_000;
const MAX_INSTRUCTION_TOTAL_CHARS = 120_000;

type InstructionScope = "user" | "project" | "local";

export interface LoadedInstructionFile {
    path: string;
    scope: InstructionScope;
    content: string;
    truncated: boolean;
}

export interface ProjectInstructions {
    files: readonly LoadedInstructionFile[];
    issues: readonly string[];
}

export const EMPTY_PROJECT_INSTRUCTIONS: ProjectInstructions = Object.freeze({
    files: Object.freeze([]),
    issues: Object.freeze([]),
});

interface InstructionCandidate {
    path: string;
    scope: InstructionScope;
}

interface ProjectInstructionLoaderConfig {
    homeDir?: string;
    maxFileChars?: number;
    maxTotalChars?: number;
}

async function readInstructionFile(
    path: string,
    maxChars: number
): Promise<{content: string; byteTruncated: boolean}> {
    const maxBytes = Math.max(1, maxChars * 4);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new Error("CODE.md 必须是普通文件，不能是目录或符号链接");
        }
        const buffer = Buffer.allocUnsafe(Math.min(info.size, maxBytes));
        const {bytesRead} = buffer.length > 0
            ? await handle.read(buffer, 0, buffer.length, 0)
            : {bytesRead: 0};
        return {
            content: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
            byteTruncated: info.size > maxBytes,
        };
    } finally {
        await handle.close();
    }
}

function discoveryDirectories(cwd: string, boundary?: string): string[] {
    const directories: string[] = [];
    let current = resolve(cwd);
    const root = boundary === undefined ? parse(current).root : resolve(boundary);
    const relation = relative(resolve(root), current);
    if (relation.startsWith("..") || isAbsolute(relation)) {
        throw new Error("CODE.md discovery boundary 不包含 cwd");
    }
    while (true) {
        directories.push(current);
        if (current === root) break;
        current = dirname(current);
    }
    return directories.reverse();
}

function instructionCandidates(
    cwd: string,
    homeDir: string,
    boundary?: string
): InstructionCandidate[] {
    const candidates: InstructionCandidate[] = [
        {path: join(homeDir, ".pillar", "CODE.md"), scope: "user"},
    ];
    for (const directory of discoveryDirectories(cwd, boundary)) {
        candidates.push(
            {path: join(directory, "CODE.md"), scope: "project"},
            {path: join(directory, ".pillar", "CODE.md"), scope: "project"},
            {path: join(directory, "CODE.local.md"), scope: "local"}
        );
    }
    return candidates;
}

function boundedFileContent(
    content: string,
    maxChars: number
): { content: string; truncated: boolean } {
    if (content.length <= maxChars) return {content, truncated: false};
    const marker = `\n\n[CODE.md truncated to ${maxChars} characters]`;
    if (marker.length >= maxChars) {
        return {content: content.slice(0, maxChars), truncated: true};
    }
    return {
        content: `${content.slice(0, maxChars - marker.length)}${marker}`,
        truncated: true,
    };
}

/**
 * Load durable CODE.md instructions in low-to-high priority order.
 *
 * The total budget is allocated from high priority to low priority, so a
 * broad parent rule cannot crowd out CODE.local.md near the active cwd.
 */
export function createProjectInstructionLoader(
    config: ProjectInstructionLoaderConfig = {}
) {
    const homeDir = resolve(config.homeDir ?? homedir());
    const maxFileChars = config.maxFileChars ?? MAX_INSTRUCTION_FILE_CHARS;
    const maxTotalChars = config.maxTotalChars ?? MAX_INSTRUCTION_TOTAL_CHARS;

    return async function loadProjectInstructions(
        cwd: string,
        boundary?: string
    ): Promise<ProjectInstructions> {
        const issues: string[] = [];
        const seen = new Set<string>();
        const discovered: LoadedInstructionFile[] = [];

        for (const candidate of instructionCandidates(cwd, homeDir, boundary)) {
            const path = resolve(candidate.path);
            if (seen.has(path)) continue;
            seen.add(path);
            try {
                const {content: raw, byteTruncated} = await readInstructionFile(
                    path,
                    maxFileChars
                );
                if (!raw.trim()) continue;
                const bounded = boundedFileContent(raw, maxFileChars);
                if (bounded.truncated || byteTruncated) {
                    issues.push(`${path} 超过 ${maxFileChars} 字符，已截断`);
                }
                discovered.push({
                    path,
                    scope: candidate.scope,
                    content: bounded.content,
                    truncated: bounded.truncated || byteTruncated,
                });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException | undefined)?.code;
                if (code !== "ENOENT" && code !== "ENOTDIR") {
                    const message = error instanceof Error ? error.message : String(error);
                    issues.push(`${path} 读取失败: ${message}`);
                }
            }
        }

        let remaining = Math.max(0, maxTotalChars);
        const budgeted = new Map<number, LoadedInstructionFile>();
        for (let index = discovered.length - 1; index >= 0; index--) {
            const file = discovered[index]!;
            if (file.content.length <= remaining) {
                remaining -= file.content.length;
                budgeted.set(index, file);
                continue;
            }
            if (remaining > 0) {
                const bounded = boundedFileContent(file.content, remaining);
                budgeted.set(index, {...file, ...bounded, truncated: true});
                issues.push(
                    `${file.path} 因 CODE.md 总预算 ${maxTotalChars} 字符被进一步截断`
                );
                remaining = 0;
            } else {
                issues.push(`${file.path} 因 CODE.md 总预算 ${maxTotalChars} 字符未注入`);
            }
        }

        return {
            files: discovered.flatMap((_, index) => {
                const file = budgeted.get(index);
                return file ? [file] : [];
            }),
            issues,
        };
    };
}

export const loadProjectInstructions = createProjectInstructionLoader();

export function formatProjectInstructions(
    instructions: ProjectInstructions
): string {
    if (instructions.files.length === 0 && instructions.issues.length === 0) {
        return "";
    }
    const files = instructions.files.map((file) => {
        const label =
            file.scope === "user"
                ? "user global instructions"
                : file.scope === "local"
                    ? "private local project instructions"
                    : "project instructions";
        return `Contents of ${file.path} (${label}):\n\n${file.content.trim()}`;
    });
    const issueSection =
        instructions.issues.length > 0
            ? [
                "CODE.md loading issues:",
                ...instructions.issues.map((issue) => `- ${issue}`),
            ].join("\n")
            : "";
    return [
        "Codebase and user instructions are shown below. Follow them when they apply to the current task.",
        "Instructions from later files take precedence when they conflict. They do not override system safety policy or the user's explicit current request.",
        "",
        ...files,
        issueSection,
    ].filter(Boolean).join("\n\n");
}
