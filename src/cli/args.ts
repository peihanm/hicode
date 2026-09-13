import {parsePermissionMode, type PermissionMode,} from "../permissions/index.js";
import {parseCollaborationMode, type CollaborationMode} from "../collaboration/index.js";
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
    storageAction?: "projects" | "inspect" | "preview" | "clean" | "repair-index";
    model?: string;
    source?: LLMProviderName;
    permissionMode?: PermissionMode;
    collaborationMode?: CollaborationMode;
    resumeMode: ResumeMode;
    printPrompt?: string;
    images?: string[];
    outputFormat: CliOutputFormat;
}

export function printHelp(): void {
    console.log(`pillar

Usage:
  pillar [options]

Options:
  -p, --print <prompt>           Run one prompt in headless mode and print the final reply
  -i, --image <path>             Attach a local PNG/JPEG/WebP; repeat for multiple images
  --output-format <format>       Headless output format: text | json
  -r, --resume [sessionId]       Resume an existing session; omit sessionId to pick from a list
  -c, --continue                 Resume the most recently updated session
  --model <model>                Override the primary model for this run
  --source <source>              Override primary model source: ${LLM_PROVIDER_NAMES.join(" | ")}
  --permission-mode <mode>       ask | auto-review | full-access
  --collaboration-mode <mode>    build | plan
  --storage <action>             projects | inspect | preview | clean | repair-index (no model request)
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
            throw new Error("Specify only one resume option: -r/--resume or -c/--continue");
        }
        options.resumeMode = resumeMode;
    };

    const setPrintPrompt = (prompt: string) => {
        if (options.printPrompt !== undefined) {
            throw new Error("Specify only one -p/--print prompt");
        }
        const trimmed = prompt.trim();
        if (!trimmed) {
            throw new Error("-p/--print requires a non-empty prompt");
        }
        options.printPrompt = trimmed;
    };

    const setOutputFormat = (value: string) => {
        if (value !== "text" && value !== "json") {
            throw new Error(`Unknown output format: ${value}`);
        }
        options.outputFormat = value;
    };

    const setModel = (value: string) => {
        const model = value.trim();
        if (!model) throw new Error("--model requires a non-empty model");
        options.model = model;
    };

    const setSource = (value: string) => {
        const source = value.trim().toLowerCase();
        if (!isLLMProviderName(source)) {
            throw new Error(
                `Unknown model source: ${value}. Available values: ${formatLLMProviderNames()}`
            );
        }
        options.source = source;
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--storage") {
            const value=args[++i];
            if(value!=="projects"&&value!=="inspect"&&value!=="preview"&&value!=="clean"&&value!=="repair-index")throw new Error("--storage requires projects, inspect, preview, clean or repair-index");
            options.storageAction=value;continue;
        }
        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }
        if (arg === "-i" || arg === "--image" || arg.startsWith("--image=")) {
            const path = arg.startsWith("--image=") ? arg.slice(8) : args[++i];
            if (!path?.trim() || path.startsWith("-")) throw new Error("--image requires a local image path");
            options.images ??= [];
            if (options.images.length >= 8) throw new Error("--image allows at most 8 images");
            options.images.push(path);
            continue;
        }
        if (arg === "-p" || arg === "--print") {
            const value = args[i + 1];
            if (!value) {
                throw new Error(`${arg} requires a prompt`);
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
                throw new Error("--output-format requires a format");
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
        if (arg === "--model") {
            const value = args[i + 1];
            if (!value) throw new Error("--model requires a model");
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
            if (!value) throw new Error("--source requires a source");
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
                throw new Error("--resume= requires a sessionId");
            }
            setResumeMode({kind: "session", sessionId: value});
            continue;
        }
        if (arg === "--permission-mode") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("--permission-mode requires a mode");
            }
            const mode = parsePermissionMode(value);
            if (!mode) {
                throw new Error(`Unknown permission mode: ${value}`);
            }
            options.permissionMode = mode;
            i++;
            continue;
        }
        if (arg === "--collaboration-mode") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("--collaboration-mode requires a mode");
            }
            const mode = parseCollaborationMode(value);
            if (!mode) {
                throw new Error(`Unknown collaboration mode: ${value}`);
            }
            options.collaborationMode = mode;
            i++;
            continue;
        }
        if (arg.startsWith("--collaboration-mode=")) {
            const value = arg.slice("--collaboration-mode=".length);
            const mode = parseCollaborationMode(value);
            if (!mode) {
                throw new Error(`Unknown collaboration mode: ${value}`);
            }
            options.collaborationMode = mode;
            continue;
        }
        if (arg.startsWith("--permission-mode=")) {
            const value = arg.slice("--permission-mode=".length);
            const mode = parsePermissionMode(value);
            if (!mode) {
                throw new Error(`Unknown permission mode: ${value}`);
            }
            options.permissionMode = mode;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.storageAction && args.length !== 2) throw new Error("Use --storage on its own");
    if (options.outputFormat !== "text" && options.printPrompt === undefined) {
        throw new Error("--output-format is only available in -p/--print headless mode");
    }

    return options;
}
