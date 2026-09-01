import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    loadPillarHostConfig,
    PillarSDKError,
} from "../../src/sdk/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {PillarSettingsFile} from "../../src/settings/index.js";

const FILE_SOURCES = {
    settings: ["user", "project", "local"],
    instructions: ["project", "local"],
    skills: ["project"],
    agents: ["project"],
    mcp: [],
    lsp: [],
} as const;

describe("SDK Host config", () => {
    test("从 Host 注入的 Pillar Home 加载用户 Settings 并合并项目层级", async () => {
        await withTempProject(async (cwd) => {
            const pillarHome = join(cwd, "host-data");
            const projectSettings = join(cwd, ".pillar");
            await mkdir(pillarHome, {recursive: true});
            await mkdir(projectSettings, {recursive: true});
            await writeFile(
                join(pillarHome, "settings.json"),
                JSON.stringify({
                    sources: {
                        qwen: {
                            models: [
                                {id: "host-qwen", label: "Host Qwen"},
                            ],
                        },
                    },
                    permissions: {defaultMode: "acceptEdits"},
                })
            );
            await writeFile(
                join(projectSettings, "settings.json"),
                JSON.stringify({checkpointing: {enabled: false}})
            );
            await writeFile(
                join(projectSettings, "settings.local.json"),
                JSON.stringify({memory: {enabled: false}})
            );

            const loaded = loadPillarHostConfig({
                cwd,
                pillarHome,
                fileSources: FILE_SOURCES,
                settingsOverrides: {
                    models: {
                        primary: {source: "qwen", model: "host-qwen"},
                    },
                },
            });

            expect(loaded.configuration.cwd).toBe(cwd);
            expect(loaded.configuration.storage.pillarHome).toBe(pillarHome);
            expect(loaded.configuration.settings.models.primary).toEqual({
                source: "qwen",
                provider: "qwen",
                model: "host-qwen",
                label: "Host Qwen",
            });
            expect(loaded.configuration.settings.permissions.defaultMode).toBe(
                "acceptEdits"
            );
            expect(loaded.configuration.settings.checkpointing.enabled).toBe(
                false
            );
            expect(loaded.configuration.settings.memory.enabled).toBe(false);
            expect(loaded.origins.primaryModel).toBe("host");
            expect(loaded.issues).toEqual([]);
        });
    });

    test("损坏的 Host Settings fail closed 并抛出类型化错误", async () => {
        await withTempProject(async (cwd) => {
            const pillarHome = join(cwd, "host-data");
            await mkdir(pillarHome, {recursive: true});
            await writeFile(join(pillarHome, "settings.json"), "{broken-json");

            expect(() => loadPillarHostConfig({
                cwd,
                pillarHome,
                fileSources: FILE_SOURCES,
            })).toThrow(
                PillarSDKError
            );
            try {
                loadPillarHostConfig({cwd, pillarHome, fileSources: FILE_SOURCES});
                throw new Error("expected loadPillarHostConfig to throw");
            } catch (error) {
                expect(error).toBeInstanceOf(PillarSDKError);
                if (!(error instanceof PillarSDKError)) return;
                expect(error.code).toBe("invalid_settings");
                expect(error.message).toContain("Settings JSON 无法解析");
            }
        });
    });

    test("模型解析失败和相对 Pillar Home 都使用稳定 SDK 错误码", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () =>
                loadPillarHostConfig({
                    cwd,
                    pillarHome: join(cwd, "host-data"),
                    fileSources: FILE_SOURCES,
                    settingsOverrides: {
                        models: {
                            primary: {source: "qwen", model: "missing-model"},
                        },
                    },
                }),
                "invalid_settings"
            );
            expectSDKErrorCode(
                () => loadPillarHostConfig({
                    cwd,
                    pillarHome: "relative-home",
                    fileSources: FILE_SOURCES,
                }),
                "invalid_pillar_home"
            );
        });
    });

    test("未选择的 Settings 来源不会被读取", async () => {
        await withTempProject(async (cwd) => {
            const pillarHome = join(cwd, "host-data");
            await mkdir(pillarHome, {recursive: true});
            await writeFile(join(pillarHome, "settings.json"), "{broken-json");

            const loaded = loadPillarHostConfig({
                cwd,
                pillarHome,
                fileSources: {
                    ...FILE_SOURCES,
                    settings: [],
                },
            });

            expect(loaded.configuration.settings.models.primary.model).toBe(
                "gpt-5.6-luna"
            );
            expect(loaded.configuration.settings.models.fast).toMatchObject({
                source: "codex",
                model: "gpt-5.6-luna",
            });
            expect(loaded.issues).toEqual([]);
        });
    });

    test("workspace boundary 必须是包含 cwd 的绝对路径", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () => loadPillarHostConfig({
                    cwd,
                    pillarHome: join(cwd, "host-data"),
                    workspaceBoundary: "relative-boundary",
                    fileSources: FILE_SOURCES,
                }),
                "invalid_configuration"
            );
            expectSDKErrorCode(
                () => loadPillarHostConfig({
                    cwd,
                    pillarHome: join(cwd, "host-data"),
                    workspaceBoundary: join(cwd, "nested"),
                    fileSources: FILE_SOURCES,
                }),
                "invalid_configuration"
            );
        });
    });

    test("Host Settings 最高优先级合并并保留 host 来源", async () => {
        await withTempProject(async (cwd) => {
            const pillarHome = join(cwd, "host-data");
            const settingsOverrides: PillarSettingsFile = {
                sources: {
                    qwen: {
                        models: [{id: "host-model", label: "Host Model"}],
                    },
                },
                models: {
                    primary: {source: "qwen", model: "host-model"},
                },
                permissions: {defaultMode: "plan"},
            };
            const loaded = loadPillarHostConfig({
                cwd,
                pillarHome,
                fileSources: FILE_SOURCES,
                settingsOverrides,
            });

            settingsOverrides.permissions!.defaultMode = "bypassPermissions";
            expect(loaded.configuration.settings.models.primary.model).toBe(
                "host-model"
            );
            expect(loaded.configuration.settings.permissions.defaultMode).toBe(
                "plan"
            );
            expect(loaded.origins.primaryModel).toBe("host");
            expect(loaded.origins.permissionMode).toBe("host");
        });
    });

    test("Host Settings 未知字段 fail closed", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () => loadPillarHostConfig({
                    cwd,
                    pillarHome: join(cwd, "host-data"),
                    fileSources: FILE_SOURCES,
                    settingsOverrides: {
                        memory: {enabled: true, typo: true},
                    } as PillarSettingsFile,
                }),
                "invalid_settings"
            );
        });
    });
});

function expectSDKErrorCode(run: () => unknown, code: string): void {
    try {
        run();
        throw new Error(`expected PillarSDKError ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(PillarSDKError);
        if (!(error instanceof PillarSDKError)) return;
        expect(error.code).toBe(code);
    }
}
