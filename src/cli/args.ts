import {parsePermissionMode, type PermissionMode,} from "../permissions/index.js";
import type {ResumeMode} from "../session/index.js";
import {
    formatLLMProviderNames,
    isLLMProviderName,
    LLM_PROVIDER_NAMES,
    type LLMProviderName,
} from "../llm/providerRegistry.js";

type CliOutputFormat = "text" | "json";

export interface CliOptions {
    help: boolean;
    model?: string;
    source?: LLMProviderName;
    permissionMode?: PermissionMode;
    resumeMode: ResumeMode;
    printPrompt?: string;
    outputFormat: CliOutputFormat;
    rewindCheckpointId?: string;
}

export function printHelp(): void {
    console.log(`pillar

Usage:
  pillar [options]

Options:
  -p, --print <prompt>           Run one prompt in headless mode and print the final reply
  --output-format <format>       Headless output format: text | json
  --rewind <checkpointId>       Restore code and conversation from -r <sessionId>
  -r, --resume [sessionId]       Resume an existing session; omit sessionId to pick from a list
  -c, --continue                 Resume the most recently updated session
  --model <model>                Override the primary model for this run
  --source <source>              Override primary model source: ${LLM_PROVIDER_NAMES.join(" | ")}
  --permission-mode <mode>       default | acceptEdits | plan | bypassPermissions | dontAsk
  --dangerously-skip-permissions Start in bypassPermissions mode
  -h, --help                     Show help
`);
}

export function parseCliArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        help: false,
        resumeMode: {kind: "none"},
        outputFormat: "text",
    };

    const setResumeMode = (resumeMode: ResumeMode) => {
        if (options.resumeMode.kind !== "none") {
            throw new Error("只能指定一个恢复参数: -r/--resume 或 -c/--continue");
        }
        options.resumeMode = resumeMode;
    };

    const setPrintPrompt = (prompt: string) => {
        if (options.printPrompt !== undefined) {
            throw new Error("只能指定一个 -p/--print prompt");
        }
        const trimmed = prompt.trim();
        if (!trimmed) {
            throw new Error("-p/--print 需要提供非空 prompt");
        }
        options.printPrompt = trimmed;
    };

    const setOutputFormat = (value: string) => {
        if (value !== "text" && value !== "json") {
            throw new Error(`未知 output format: ${value}`);
        }
        options.outputFormat = value;
    };

    const setModel = (value: string) => {
        const model = value.trim();
        if (!model) throw new Error("--model 需要提供非空 model");
        options.model = model;
    };

    const setSource = (value: string) => {
        const source = value.trim().toLowerCase();
        if (!isLLMProviderName(source)) {
            throw new Error(
                `未知模型来源: ${value}。可选值：${formatLLMProviderNames()}`
            );
        }
        options.source = source;
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }
        if (arg === "-p" || arg === "--print") {
            const value = args[i + 1];
            if (!value) {
                throw new Error(`${arg} 需要提供 prompt`);
            }
            setPrintPrompt(value);
            i++;
            continue;
        }
        if (arg.startsWith("--print=")) {
            setPrintPrompt(arg.slice("--print=".length));
            continue;
        }
        if (arg === "--output-format") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("--output-format 需要提供 format");
            }
            setOutputFormat(value);
            i++;
            continue;
        }
        if (arg.startsWith("--output-format=")) {
            setOutputFormat(arg.slice("--output-format=".length));
            continue;
        }
        if (arg === "-c" || arg === "--continue") {
            setResumeMode({kind: "continue"});
            continue;
        }
        if (arg === "--rewind") {
            const value = args[i + 1]?.trim();
            if (!value || value.startsWith("-")) {
                throw new Error("--rewind 需要提供 checkpointId");
            }
            options.rewindCheckpointId = value;
            i++;
            continue;
        }
        if (arg.startsWith("--rewind=")) {
            const value = arg.slice("--rewind=".length).trim();
            if (!value) throw new Error("--rewind 需要提供 checkpointId");
            options.rewindCheckpointId = value;
            continue;
        }
        if (arg === "--model") {
            const value = args[i + 1];
            if (!value) throw new Error("--model 需要提供 model");
            setModel(value);
            i++;
            continue;
        }
        if (arg.startsWith("--model=")) {
            setModel(arg.slice("--model=".length));
            continue;
        }
        if (arg === "--source") {
            const value = args[i + 1];
            if (!value) throw new Error("--source 需要提供 source");
            setSource(value);
            i++;
            continue;
        }
        if (arg.startsWith("--source=")) {
            setSource(arg.slice("--source=".length));
            continue;
        }
        if (arg === "-r" || arg === "--resume") {
            const value = args[i + 1];
            if (value && !value.startsWith("-")) {
                setResumeMode({kind: "session", sessionId: value});
                i++;
            } else {
                setResumeMode({kind: "picker"});
            }
            continue;
        }
        if (arg.startsWith("--resume=")) {
            const value = arg.slice("--resume=".length).trim();
            if (!value) {
                throw new Error("--resume= 需要提供 sessionId");
            }
            setResumeMode({kind: "session", sessionId: value});
            continue;
        }
        if (arg === "--dangerously-skip-permissions") {
            options.permissionMode = "bypassPermissions";
            continue;
        }
        if (arg === "--permission-mode") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("--permission-mode 需要提供 mode");
            }
            const mode = parsePermissionMode(value);
            if (!mode) {
                throw new Error(`未知权限模式: ${value}`);
            }
            options.permissionMode = mode;
            i++;
            continue;
        }
        if (arg.startsWith("--permission-mode=")) {
            const value = arg.slice("--permission-mode=".length);
            const mode = parsePermissionMode(value);
            if (!mode) {
                throw new Error(`未知权限模式: ${value}`);
            }
            options.permissionMode = mode;
            continue;
        }
        throw new Error(`未知参数: ${arg}`);
    }

    if (options.rewindCheckpointId) {
        if (options.printPrompt !== undefined) {
            throw new Error("--rewind 不能和 -p/--print 同时使用");
        }
        if (options.resumeMode.kind !== "session") {
            throw new Error("--rewind 必须和 -r <sessionId> 一起使用");
        }
    }

    if (
        options.outputFormat !== "text" &&
        options.printPrompt === undefined &&
        options.rewindCheckpointId === undefined
    ) {
        throw new Error("--output-format 只能用于 -p/--print 或 --rewind headless 模式");
    }

    return options;
}
