import {
    appendFile,
    cp,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import type {
    EvalCase,
    EvalKeepPolicy,
    EvalManifest,
    EvalModelSource,
    EvalRunPaths,
} from "./types.js";
import {createVerifierEnvironment, runProcess} from "./process.js";

interface PreparedEvalRun {
    runId: string;
    paths: EvalRunPaths;
    baselineCommit: string;
    verifierEnvironment: Record<string, string>;
}

export async function prepareEvalRun(
    evalCase: EvalCase,
    options: {
        evalRoot: string;
        settingsFile?: string;
        source?: EvalModelSource;
        model?: string;
        envFileProvided: boolean;
        keep: EvalKeepPolicy;
    }
): Promise<PreparedEvalRun> {
    if (!isAbsolute(options.evalRoot)) {
        throw new Error("Eval Root 必须是绝对路径");
    }
    const runId = createRunId(evalCase.id);
    const runDirectory = join(resolve(options.evalRoot), "runs", runId);
    const paths = createRunPaths(runDirectory);
    await mkdir(runDirectory, {recursive: true});
    await cp(evalCase.fixtureDirectory, paths.workspace, {
        recursive: true,
        errorOnExist: true,
        force: false,
    });
    await materializeFixtureTemplates(paths.workspace);
    await mkdir(paths.pillarHome, {recursive: true});
    const verifierEnvironment = await createVerifierEnvironment(
        paths.verifierHome
    );
    await writeEvalSettings(
        options.settingsFile,
        join(paths.pillarHome, "settings.json"),
        options.source,
        options.model
    );
    const baselineCommit = await initializeGitRepository(
        paths.workspace,
        verifierEnvironment
    );
    const manifest: EvalManifest = {
        schemaVersion: 1,
        runId,
        caseId: evalCase.id,
        description: evalCase.description,
        status: "running",
        startedAt: new Date().toISOString(),
        source: options.source,
        model: options.model,
        envFileProvided: options.envFileProvided,
        keep: options.keep,
        paths,
        baselineCommit,
    };
    await writeJsonAtomic(paths.manifest, manifest);
    return {runId, paths, baselineCommit, verifierEnvironment};
}

export async function writeJsonAtomic(
    path: string,
    value: unknown
): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, path);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
    await appendFile(path, `${JSON.stringify(value)}\n`, {mode: 0o600});
}

export async function collectWorkspaceDiff(
    workspace: string,
    baselineCommit: string,
    verifierEnvironment: Record<string, string>
): Promise<{diff: string; changedPaths: string[]}> {
    const intent = await runProcess(["git", "add", "--intent-to-add", "--all"], {
        cwd: workspace,
        env: verifierEnvironment,
        timeoutMs: 15_000,
    });
    requireSuccessfulProcess(intent, "Git intent-to-add");
    const [diff, names] = await Promise.all([
        runProcess(
            ["git", "diff", "--binary", "--no-ext-diff", baselineCommit, "--"],
            {
                cwd: workspace,
                env: verifierEnvironment,
                timeoutMs: 15_000,
                maxOutputBytes: 16 * 1024 * 1024,
            }
        ),
        runProcess(
            ["git", "diff", "--name-only", "-z", baselineCommit, "--"],
            {
                cwd: workspace,
                env: verifierEnvironment,
                timeoutMs: 15_000,
            }
        ),
    ]);
    requireSuccessfulProcess(diff, "Git diff");
    requireSuccessfulProcess(names, "Git changed paths");
    return {
        diff: diff.stdout,
        changedPaths: names.stdout.split("\0").filter(Boolean).sort(),
    };
}

export async function locateSessionArtifacts(
    pillarHome: string
): Promise<{sessionIndexPath?: string; sessionEventsPath?: string}> {
    const projectsRoot = join(pillarHome, "projects");
    let projectEntries;
    try {
        projectEntries = await readdir(projectsRoot, {withFileTypes: true});
    } catch {
        return {};
    }
    for (const projectEntry of projectEntries.slice(0, 10)) {
        if (!projectEntry.isDirectory()) continue;
        const sessionsRoot = join(projectsRoot, projectEntry.name, "sessions");
        let sessionEntries;
        try {
            sessionEntries = await readdir(sessionsRoot, {withFileTypes: true});
        } catch {
            continue;
        }
        const sessionDirectory = sessionEntries.find(
            (entry) => entry.isDirectory() && entry.name.startsWith("session-")
        );
        return {
            sessionIndexPath: join(sessionsRoot, "index.json"),
            ...(sessionDirectory
                ? {
                    sessionEventsPath: join(
                        sessionsRoot,
                        sessionDirectory.name,
                        "events.jsonl"
                    ),
                }
                : {}),
        };
    }
    return {};
}

export async function applyRetentionPolicy(
    paths: EvalRunPaths,
    keep: EvalKeepPolicy,
    passed: boolean
): Promise<{workspace: boolean; pillarHome: boolean}> {
    const retain = keep === "all" || (keep === "failed" && !passed);
    if (retain) return {workspace: true, pillarHome: true};
    await rm(paths.workspace, {recursive: true, force: true});
    await rm(paths.pillarHome, {recursive: true, force: true});
    await rm(paths.verifierHome, {recursive: true, force: true});
    return {workspace: false, pillarHome: false};
}

function createRunPaths(runDirectory: string): EvalRunPaths {
    return {
        runDirectory,
        workspace: join(runDirectory, "workspace"),
        pillarHome: join(runDirectory, "pillar-home"),
        verifierHome: join(runDirectory, "verifier-home"),
        manifest: join(runDirectory, "manifest.json"),
        report: join(runDirectory, "report.json"),
        transcript: join(runDirectory, "transcript.json"),
        sdkEvents: join(runDirectory, "sdk-events.jsonl"),
        interactions: join(runDirectory, "interactions.jsonl"),
        diagnostics: join(runDirectory, "diagnostics.jsonl"),
        verification: join(runDirectory, "verification.json"),
        diff: join(runDirectory, "diff.patch"),
    };
}

async function writeEvalSettings(
    sourcePath: string | undefined,
    targetPath: string,
    source: EvalModelSource | undefined,
    model: string | undefined
): Promise<void> {
    let userSettings: Record<string, unknown> = {};
    if (sourcePath) {
        const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
        if (!isRecord(raw)) {
            throw new Error("Eval Settings 必须是 JSON object");
        }
        userSettings = raw;
    }
    const generated: Record<string, unknown> = {
        memory: {enabled: false, autoExtract: false},
        checkpointing: {enabled: true},
        permissions: {defaultMode: "default"},
        sandbox: {enabled: false},
    };
    if (isRecord(userSettings.sources)) {
        generated.sources = userSettings.sources;
    }
    if (isRecord(userSettings.models)) {
        generated.models = userSettings.models;
    }
    if (source && model) {
        generated.models = {
            ...(isRecord(generated.models) ? generated.models : {}),
            primary: {source, model},
            fast: {source, model},
        };
    }
    await writeJsonAtomic(targetPath, generated);
}

async function initializeGitRepository(
    workspace: string,
    environment: Record<string, string>
): Promise<string> {
    const commands: readonly string[][] = [
        ["git", "init", "--quiet"],
        ["git", "config", "user.name", "Pillar Eval"],
        ["git", "config", "user.email", "eval@pillar.invalid"],
        ["git", "add", "--all"],
        ["git", "commit", "--quiet", "--no-gpg-sign", "-m", "eval baseline"],
    ];
    for (const command of commands) {
        const result = await runProcess(command, {
            cwd: workspace,
            env: environment,
            timeoutMs: 15_000,
        });
        requireSuccessfulProcess(result, command.join(" "));
    }
    const head = await runProcess(["git", "rev-parse", "HEAD"], {
        cwd: workspace,
        env: environment,
        timeoutMs: 15_000,
    });
    requireSuccessfulProcess(head, "git rev-parse HEAD");
    return head.stdout.trim();
}

async function materializeFixtureTemplates(directory: string): Promise<void> {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            await materializeFixtureTemplates(path);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".fixture")) continue;
        await rename(path, path.slice(0, -".fixture".length));
    }
}

function requireSuccessfulProcess(
    result: {exitCode: number; stderr: string; spawnError?: string},
    label: string
): void {
    if (result.exitCode === 0 && !result.spawnError) return;
    const detail = result.spawnError || result.stderr.trim() ||
        `exit ${result.exitCode}`;
    throw new Error(
        `${label} 失败: ${detail}`
    );
}

function createRunId(caseId: string): string {
    const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    return `${timestamp}_${caseId}_${randomUUID().slice(0, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
