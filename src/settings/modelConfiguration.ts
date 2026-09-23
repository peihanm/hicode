import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {lstat, mkdir, realpath} from "node:fs/promises";
import {dirname, join} from "node:path";
import {parse as parseEnv} from "dotenv";
import {ensurePrivateStorageDirectory, hasFileSystemErrorCode, withFileLock, writeFileAtomically, type HiCodeStorageLayout} from "../persistence/index.js";
import {getUserCredentialsPath, getUserSettingsPath} from "../persistence/layout.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {PrimaryModelRuntime} from "../runtime/primaryModel.js";
import {hicodeSettingsFileSchema} from "./schema.js";
import {getSettingsPath} from "./document.js";
import {resolveHiCodeSettings, resolveModelSources} from "./resolve.js";
import type {HiCodeSettingsFile, ModelTargetSettings, LoadedSettingsDocument} from "./types.js";

const MAX_BYTES = 4 * 1024 * 1024;

export interface ModelConfiguration {
    saveKey(source: LLMProviderName, key: string): Promise<string>;
    saveEndpoint(source: LLMProviderName, baseUrl: string): Promise<void>;
    addModel(source: LLMProviderName, id: string, label: string, imageInput?: boolean): Promise<void>;
    removeModel(source: LLMProviderName, id: string): Promise<void>;
    saveSelection(target: ModelTargetSettings): Promise<void>;
}

/** Trusted configuration UI only; never exposed in ToolContext or model events. */
export function createModelConfiguration(storage: HiCodeStorageLayout, cwd: string, runtime: PrimaryModelRuntime, fixedTargets: readonly ModelTargetSettings[] = []): ModelConfiguration {
    const userPath = getUserSettingsPath(storage);
    const projectPath = getSettingsPath(cwd, "project");
    const localPath = getSettingsPath(cwd, "local");
    const projectEnv = join(cwd, ".env");
    const userEnv = getUserCredentialsPath(storage);

    async function ensureParent(path: string, create = true): Promise<void> {
        if (path === userPath || path === userEnv) {
            if (create) ensurePrivateStorageDirectory(storage, storage.hicodeHome);
            else {
                const info = await lstat(storage.hicodeHome);
                if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe user configuration directory");
            }
        } else if (path === localPath || path === projectPath) {
            const directory = dirname(path);
            if (create) await mkdir(directory, {recursive: true, mode: 0o700});
            const info = await lstat(directory);
            if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== join(await realpath(cwd), ".hicode")) {
                throw new Error("Unsafe project configuration directory");
            }
        } else if (path !== projectEnv) throw new Error("Unknown configuration path");
    }

    async function read(path: string): Promise<string> {
        try {
            await ensureParent(path, false);
            return readBoundedTextFile(path, MAX_BYTES);
        } catch (error) {
            if (hasFileSystemErrorCode(error, "ENOENT")) return "";
            throw new Error("Cannot safely read configuration; check its file type, encoding and permissions");
        }
    }

    function decode(text: string): HiCodeSettingsFile {
        try {return hicodeSettingsFileSchema.parse(text.trim() ? JSON.parse(text) : {});}
        catch {throw new Error("Invalid settings file; existing contents were not overwritten");}
    }

    async function update(path: string, modify: (settings: HiCodeSettingsFile) => void | Promise<void>): Promise<HiCodeSettingsFile> {
        await ensureParent(path);
        return withFileLock(`${path}.lock`, async () => {
            const before = await read(path);
            const settings = decode(before);
            await modify(settings);
            const normalized = decode(JSON.stringify(settings));
            if (path === userPath && normalized.sources) resolveModelSources([{source: "user", path: userPath, value: {sources: normalized.sources}}]);
            const text = `${JSON.stringify(normalized, null, 2)}\n`;
            if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Configuration exceeds 4 MiB");
            if (await read(path) !== before) throw new Error("Configuration changed while saving; retry after reviewing it");
            await writeFileAtomically(path, text, 0o600);
            return normalized;
        });
    }

    function refresh(settings: HiCodeSettingsFile): void {
        // Only connection metadata is refreshed; permissions and other Root resources stay with their owner.
        const sources = resolveModelSources([{source: "user", path: userPath, value: {sources: settings.sources}}]);
        runtime.updateSources(sources);
    }

    return {
        async saveKey(source, rawKey) {
            const key = rawKey.trim();
            if (!key || key.length > 8192 || /[\s'"\\\x00-\x1f\x7f]/.test(key)) throw new Error("Enter a single-line API key without quotes or spaces");
            const name = runtime.sources[source].apiKeyEnv;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(PATH|HOME|SHELL|NODE_OPTIONS|BUN_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(name)) throw new Error("Unsafe credential variable name");
            const project = parseEnv(await read(projectEnv));
            const path = Object.hasOwn(project, name) ? projectEnv : userEnv;
            await ensureParent(path);
            await withFileLock(`${path}.lock`, async () => {
                const before = await read(path);
                const parsedBefore = parseEnv(before);
                const previous = parsedBefore[name];
                if (previous && /[\r\n]/.test(previous)) throw new Error("Existing credential spans multiple lines; edit that entry manually");
                const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
                const lines = before.split(/\r?\n/).filter(line => !matcher.test(line));
                while (lines.at(-1) === "") lines.pop();
                const next = [...lines, `${name}='${key}'`, ""].join("\n");
                const parsedNext = parseEnv(next);
                if (Object.entries(parsedBefore).some(([field, value]) => field !== name && parsedNext[field] !== value)) throw new Error("Cannot update the credential without changing another variable; edit that entry manually");
                if (Buffer.byteLength(next) > MAX_BYTES || parsedNext[name] !== key) throw new Error("Cannot encode this credential safely");
                if (await read(path) !== before) throw new Error("Credential file changed while saving; retry");
                await writeFileAtomically(path, next, 0o600);
            });
            process.env[name] = key;
            return path;
        },
        async saveEndpoint(source, value) {
            const baseUrl = value.trim();
            if (baseUrl) {
                let url: URL;
                try {url = new URL(baseUrl);} catch {throw new Error("Enter a valid API base URL");}
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP(S) base URL without credentials, query or fragment");
            }
            const settings = await update(userPath, settings => {
                settings.sources ??= {};
                const connection = {...settings.sources[source]};
                if (baseUrl) connection.baseUrl = baseUrl; else delete connection.baseUrl;
                settings.sources[source] = connection;
            });
            refresh(settings);
        },
        async addModel(source, rawId, rawLabel, imageInput = false) {
            const id = rawId.trim(), label = rawLabel.trim() || id;
            if (!id || id.length > 200 || label.length > 200 || /[\x00-\x1f\x7f]/.test(id + label)) throw new Error("Model ID is required; ID and display name must be at most 200 characters");
            const settings = await update(userPath, settings => {
                settings.sources ??= {};
                const connection = {...settings.sources[source]};
                const models = connection.models ?? runtime.sources[source].models;
                if (models.some(model => model.id === id)) throw new Error("This model ID already exists for this provider");
                connection.models = [...models, {id, label, imageInput}];
                settings.sources[source] = connection;
            });
            refresh(settings);
        },
        async removeModel(source, id) {
            const matches = (target: ModelTargetSettings | undefined) => target?.source === source && target.model === id;
            const assertNotSelected = () => {
                if ([runtime.target, ...fixedTargets].some(matches)) throw new Error("This model is in use. Switch the main model with /model, or change the explicit fast/reviewer setting and restart first.");
            };
            assertNotSelected();
            const settings = await update(userPath, async settings => {
                const documents: LoadedSettingsDocument[] = [{source: "user", path: userPath, value: settings}];
                const models = resolveModelSources(documents)[source].models;
                if (!models.some(model => model.id === id)) throw new Error("Model not found; reopen the model list");
                for (const scope of ["user", "project", "local"] as const) {
                    if (scope !== "user") {
                        const path = scope === "project" ? projectPath : localPath;
                        documents.push({source: scope, path, value: decode(await read(path))});
                    }
                    const targets = resolveHiCodeSettings(documents).values.models;
                    for (const slot of ["primary", "fast", "reviewer"] as const) {
                        if (matches(targets[slot])) throw new Error(`This model is referenced by ${slot} in ${scope} settings. Choose another model before deleting it.`);
                    }
                }
                assertNotSelected();
                settings.sources ??= {};
                settings.sources[source] = {...settings.sources[source], models: models.filter(model => model.id !== id)};
            });
            refresh(settings);
        },
        async saveSelection(target) {
            if (!runtime.available.some(item => item.source === target.source && item.model === target.model)) throw new Error("Model is not available; configure its API key first");
            const project = decode(await read(projectPath));
            const local = decode(await read(localPath));
            const overridden = [project, local].some(settings => settings.models?.primary?.source !== undefined || settings.models?.primary?.model !== undefined);
            const path = overridden ? localPath : userPath;
            await update(path, settings => {
                settings.models = {...settings.models, primary: {source: target.source, model: target.model}};
            });
            runtime.select(target);
        },
    };
}
