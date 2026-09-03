#!/usr/bin/env bun
import {config as loadEnvFile} from "dotenv";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {parseArgs} from "node:util";
import {
    collectTurnResult,
    loadPillarHostConfig,
    Pillar,
    PillarSDKError,
    type InteractionRequest,
    type ResolvedPillarSettings,
    type ThreadEvent,
    type TurnOptions,
    type TurnResult,
} from "pillar/sdk";

type ModelSource = ResolvedPillarSettings["models"]["primary"]["source"];
type PermissionMode = NonNullable<TurnOptions["permissionMode"]>;
type OutputFormat = "text" | "json";

interface RunnerOptions {
    cwd: string;
    pillarHome: string;
    prompt: string;
    envFile?: string;
    model?: string;
    source?: ModelSource;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    maxIterations?: number;
    timeoutMs: number;
    outputFormat: OutputFormat;
    printEvents: boolean;
    allowInteractions: boolean;
}

async function main(): Promise<void> {
    const options = parseRunnerOptions(process.argv.slice(2));
    if (!options) return;
    if (options.envFile) {
        const loaded = loadEnvFile({
            path: options.envFile,
            override: true,
            quiet: true,
        });
        if (loaded.error) {
            throw new PillarSDKError(
                "env_load_failed",
                `无法加载 env file: ${options.envFile}: ${loaded.error.message}`
            );
        }
    }

    const hostConfig = loadPillarHostConfig({
        cwd: options.cwd,
        pillarHome: options.pillarHome,
        fileSources: {
            settings: ["user", "project", "local"],
            instructions: ["project", "local"],
            skills: ["project"],
            agents: ["project"],
            mcp: [],
        },
        ...(options.model || options.source
            ? {
                settingsOverrides: {
                    models: {
                        primary: {
                            ...(options.model ? {model: options.model} : {}),
                            ...(options.source ? {source: options.source} : {}),
                        },
                    },
                },
            }
            : {}),
    });
    for (const issue of hostConfig.issues) {
        process.stderr.write(
            `[settings:${issue.severity}] ${issue.source === "host" ? issue.id : issue.path}${issue.field ? ` (${issue.field})` : ""}: ${issue.message}\n`
        );
    }

    const turnController = new AbortController();
    const onSigint = () => abortTurn(turnController, "sigint");
    const onSigterm = () => abortTurn(turnController, "shutdown");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const timeout = setTimeout(
        () => abortTurn(turnController, "timeout"),
        options.timeoutMs
    );
    timeout.unref?.();

    let pillar: Pillar | undefined;
    try {
        pillar = await Pillar.create({
            configuration: hostConfig.configuration,
            host: {
                onInteraction: async (request) =>
                    decideInteraction(request, options.allowInteractions),
                onDiagnostic(diagnostic) {
                    process.stderr.write(
                        `[${diagnostic.severity}:${diagnostic.scope}] ${diagnostic.message}\n`
                    );
                },
            },
        });
        const thread = options.resumeSessionId
            ? await pillar.resumeThread(options.resumeSessionId)
            : await pillar.startThread({
                permissionMode: options.permissionMode,
            });
        const streamed = await thread.runStreamed(options.prompt, {
            signal: turnController.signal,
            permissionMode: options.permissionMode,
            maxIterations: options.maxIterations,
        });
        const events = options.printEvents
            ? observeEvents(streamed.events)
            : streamed.events;
        const result = await collectTurnResult(events);
        writeResult(result, options.outputFormat);
        if (result.stopReason === "interrupted") {
            process.exitCode = result.abortReason === "sigint" ? 130 : 1;
        }
    } finally {
        clearTimeout(timeout);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        await pillar?.close();
    }
}

function parseRunnerOptions(args: string[]): RunnerOptions | undefined {
    const parsed = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            help: {type: "boolean", short: "h"},
            prompt: {type: "string", short: "p"},
            cwd: {type: "string"},
            "pillar-home": {type: "string"},
            "env-file": {type: "string"},
            model: {type: "string"},
            source: {type: "string"},
            "permission-mode": {type: "string"},
            resume: {type: "string"},
            "max-iterations": {type: "string"},
            "timeout-ms": {type: "string"},
            "output-format": {type: "string"},
            events: {type: "boolean"},
            "allow-interactions": {type: "boolean"},
        },
    });
    if (parsed.values.help) {
        printHelp();
        return undefined;
    }
    const prompt = requireText(parsed.values.prompt, "--prompt");
    const cwd = resolve(parsed.values.cwd ?? process.cwd());
    const pillarHome = resolve(
        parsed.values["pillar-home"] ?? join(homedir(), ".pillar")
    );
    const source = optionalModelSource(parsed.values.source);
    const permissionMode = optionalPermissionMode(
        parsed.values["permission-mode"]
    );
    const outputFormat = parseOutputFormat(parsed.values["output-format"]);
    return {
        cwd,
        pillarHome,
        prompt,
        envFile: parsed.values["env-file"]
            ? resolve(parsed.values["env-file"])
            : undefined,
        model: optionalText(parsed.values.model, "--model"),
        source,
        permissionMode,
        resumeSessionId: optionalText(parsed.values.resume, "--resume"),
        maxIterations: optionalInteger(
            parsed.values["max-iterations"],
            "--max-iterations",
            1,
            100
        ),
        timeoutMs: optionalInteger(
            parsed.values["timeout-ms"],
            "--timeout-ms",
            1_000,
            3_600_000
        ) ?? 300_000,
        outputFormat,
        printEvents: parsed.values.events ?? false,
        allowInteractions: parsed.values["allow-interactions"] ?? false,
    };
}

function printHelp(): void {
    process.stdout.write(`Pillar TypeScript SDK runner

Usage:
  bun run sdk:run -- --prompt <text> [options]

Options:
  -p, --prompt <text>             Required prompt
      --cwd <path>                Workspace (default: process cwd)
      --pillar-home <path>        Host data root (default: ~/.pillar)
      --env-file <path>           Explicit env file; values override current env
      --source <source>           glm | qwen | deepseek
      --model <model>             Primary model override
      --permission-mode <mode>    default | readOnly | bypassPermissions
      --resume <sessionId>        Resume an existing SDK Thread
      --max-iterations <n>        1..100
      --timeout-ms <ms>           1000..3600000 (default: 300000)
      --output-format <format>    text | json (default: text)
      --events                    Write protocol events as sensitive JSONL to stderr
      --allow-interactions        Auto-allow permission/MCP/Hook prompts once; questions still deny
  -h, --help                      Show help

The SDK never loads .env implicitly. Use --env-file or provide the Provider key
in the runner process environment.
`);
}

function decideInteraction(
    request: InteractionRequest,
    allowInteractions: boolean
) {
    if (request.kind === "question") {
        return Promise.resolve({
            behavior: "deny" as const,
            message: "SDK runner 没有交互式 question UI",
        });
    }
    if (!allowInteractions) {
        return Promise.resolve({
            behavior: "deny" as const,
            message: "SDK runner 默认拒绝交互；需要时显式使用 --allow-interactions",
        });
    }
    return Promise.resolve({behavior: "allow" as const, persistence: "once" as const});
}

async function* observeEvents(
    events: AsyncIterable<ThreadEvent>
): AsyncGenerator<ThreadEvent> {
    for await (const event of events) {
        process.stderr.write(`${JSON.stringify(event)}\n`);
        yield event;
    }
}

function writeResult(result: TurnResult, format: OutputFormat): void {
    if (format === "json") {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    for (const item of result.items) {
        if (item.type === "tool_call") {
            process.stderr.write(
                `[tool:${item.outcome ?? item.status}] ${item.name}${item.resultPreview ? ` — ${oneLine(item.resultPreview)}` : ""}\n`
            );
        } else if (item.type === "file_change") {
            for (const change of item.changes) {
                process.stderr.write(`[file:${change.kind}] ${change.path}\n`);
            }
        }
    }
    process.stdout.write(`${result.finalResponse}\n`);
    process.stderr.write(
        `[turn:${result.stopReason}] iterations=${result.iterations} durationMs=${result.durationMs}${result.usage ? ` usage=${JSON.stringify(result.usage)}` : ""}\n`
    );
}

function abortTurn(controller: AbortController, reason: string): void {
    if (!controller.signal.aborted) controller.abort(reason);
}

function requireText(value: string | undefined, name: string): string {
    const text = value?.trim();
    if (!text) throw new PillarSDKError("invalid_runner_option", `${name} 需要非空值`);
    return text;
}

function optionalText(
    value: string | undefined,
    name: string
): string | undefined {
    return value === undefined ? undefined : requireText(value, name);
}

function optionalInteger(
    value: string | undefined,
    name: string,
    min: number,
    max: number
): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new PillarSDKError(
            "invalid_runner_option",
            `${name} 必须是 ${min}-${max} 的整数`
        );
    }
    return parsed;
}

function optionalModelSource(value: string | undefined): ModelSource | undefined {
    if (value === undefined) return undefined;
    if (
        value === "glm" ||
        value === "qwen" ||
        value === "deepseek"
    ) {
        return value;
    }
    throw new PillarSDKError(
        "invalid_runner_option",
        "--source 必须是 glm | qwen | deepseek"
    );
}

function optionalPermissionMode(
    value: string | undefined
): PermissionMode | undefined {
    if (value === undefined) return undefined;
    if (
        value === "default" ||
        value === "readOnly" ||
        value === "bypassPermissions"
    ) {
        return value;
    }
    throw new PillarSDKError(
        "invalid_runner_option",
        "--permission-mode 必须是 default | readOnly | bypassPermissions"
    );
}

function parseOutputFormat(value: string | undefined): OutputFormat {
    if (value === undefined || value === "text") return "text";
    if (value === "json") return "json";
    throw new PillarSDKError(
        "invalid_runner_option",
        "--output-format 必须是 text 或 json"
    );
}

function oneLine(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= 240
        ? normalized
        : `${normalized.slice(0, 239)}…`;
}

main().catch((error: unknown) => {
    const code = error instanceof PillarSDKError ? error.code : "runner_error";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${code}] ${message}\n`);
    process.exitCode = 1;
});
