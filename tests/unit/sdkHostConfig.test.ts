import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    loadHiCodeHostConfig,
    HiCodeSDKError,
} from "../../src/sdk/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {HiCodeSettingsFile} from "../../src/settings/index.js";

const FILE_SOURCES = {
    settings: ["user", "project", "local"],
    instructions: ["project", "local"],
    skills: ["project"],
    agents: ["project"],
    mcp: [],
} as const;

describe("SDK Host config", () => {
    test("从 Host 注入的 HiCode Home 加载用户 Settings 并合并项目层级", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "host-data");
            const projectSettings = join(cwd, ".hicode");
            await mkdir(hicodeHome, {recursive: true});
            await mkdir(projectSettings, {recursive: true});
            await writeFile(
                join(hicodeHome, "settings.json"),
                JSON.stringify({
                    sources: {
                        qwen: {
                            models: [
                                {id: "host-qwen", label: "Host Qwen"},
                            ],
                        },
                    },
                    permissions: {defaultMode: "ask"},
                })
            );
            await writeFile(
                join(projectSettings, "settings.json"),
                JSON.stringify({})
            );
            await writeFile(
                join(projectSettings, "settings.local.json"),
                JSON.stringify({memory: {enabled: false}})
            );

            const loaded = loadHiCodeHostConfig({
                cwd,
                hicodeHome,
                fileSources: FILE_SOURCES,
                settingsOverrides: {
                    models: {
                        primary: {source: "qwen", model: "host-qwen"},
                    },
                },
            });

            expect(loaded.configuration.cwd).toBe(cwd);
            expect(loaded.configuration.storage.hicodeHome).toBe(hicodeHome);
            expect(loaded.configuration.settings.models.primary).toEqual({
                source: "qwen",
                model: "host-qwen",
                label: "Host Qwen",
            });
            expect(loaded.configuration.settings.models.fast).toBeUndefined();
            expect(loaded.configuration.settings.permissions.defaultMode).toBe(
                "ask"
            );
            expect(loaded.configuration.settings.memory.enabled).toBe(false);
            expect(loaded.origins.primaryModel).toBe("host");
            expect(loaded.issues).toEqual([]);
        });
    });

    test("损坏的 Host Settings fail closed 并抛出类型化错误", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "host-data");
            await mkdir(hicodeHome, {recursive: true});
            await writeFile(join(hicodeHome, "settings.json"), "{broken-json");

            expect(() => loadHiCodeHostConfig({
                cwd,
                hicodeHome,
                fileSources: FILE_SOURCES,
            })).toThrow(
                HiCodeSDKError
            );
            try {
                loadHiCodeHostConfig({cwd, hicodeHome, fileSources: FILE_SOURCES});
                throw new Error("expected loadHiCodeHostConfig to throw");
            } catch (error) {
                expect(error).toBeInstanceOf(HiCodeSDKError);
                if (!(error instanceof HiCodeSDKError)) return;
                expect(error.code).toBe("invalid_settings");
                expect(error.message).toContain("Failed to parse Settings JSON");
            }
        });
    });

    test("模型解析失败和相对 HiCode Home 都使用稳定 SDK 错误码", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () =>
                loadHiCodeHostConfig({
                    cwd,
                    hicodeHome: join(cwd, "host-data"),
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
                () => loadHiCodeHostConfig({
                    cwd,
                    hicodeHome: "relative-home",
                    fileSources: FILE_SOURCES,
                }),
                "invalid_hicode_home"
            );
            expectSDKErrorCode(
                () => loadHiCodeHostConfig({
                    cwd: "relative-workspace",
                    hicodeHome: join(cwd, "host-data"),
                    fileSources: FILE_SOURCES,
                }),
                "invalid_cwd"
            );
        });
    });

    test("未选择的 Settings 来源不会被读取", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "host-data");
            await mkdir(hicodeHome, {recursive: true});
            await writeFile(join(hicodeHome, "settings.json"), "{broken-json");

            const loaded = loadHiCodeHostConfig({
                cwd,
                hicodeHome,
                fileSources: {
                    ...FILE_SOURCES,
                    settings: [],
                },
            });

            expect(loaded.configuration.settings.models.primary.model).toBe(
                "qwen3.8-flash"
            );
            expect(loaded.configuration.settings.models.fast).toBeUndefined();
            expect(loaded.issues).toEqual([]);
        });
    });

    test("Settings 来源输入顺序不改变固定覆盖优先级", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "host-data");
            const projectSettings = join(cwd, ".hicode");
            await mkdir(hicodeHome, {recursive: true});
            await mkdir(projectSettings, {recursive: true});
            await writeFile(
                join(hicodeHome, "settings.json"),
                JSON.stringify({permissions: {defaultMode: "ask"}})
            );
            await writeFile(
                join(projectSettings, "settings.local.json"),
                JSON.stringify({
                    permissions: {defaultMode: "auto-review"},
                })
            );

            const loaded = loadHiCodeHostConfig({
                cwd,
                hicodeHome,
                fileSources: {
                    ...FILE_SOURCES,
                    settings: ["local", "user"],
                },
            });

            expect(loaded.configuration.fileSources.settings).toEqual([
                "user",
                "local",
            ]);
            expect(loaded.configuration.settings.permissions.defaultMode).toBe(
                "auto-review"
            );
        });
    });

    test("workspace boundary 必须是包含 cwd 的绝对路径", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () => loadHiCodeHostConfig({
                    cwd,
                    hicodeHome: join(cwd, "host-data"),
                    workspaceBoundary: "relative-boundary",
                    fileSources: FILE_SOURCES,
                }),
                "invalid_configuration"
            );
            expectSDKErrorCode(
                () => loadHiCodeHostConfig({
                    cwd,
                    hicodeHome: join(cwd, "host-data"),
                    workspaceBoundary: join(cwd, "nested"),
                    fileSources: FILE_SOURCES,
                }),
                "invalid_configuration"
            );
        });
    });

    test("Host Settings 最高优先级合并并保留 host 来源", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "host-data");
            const context = {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000};
            const settingsOverrides: HiCodeSettingsFile = {
                context,
                sources: {
                    qwen: {
                        models: [{id: "host-model", label: "Host Model"}],
                    },
                },
                models: {
                    primary: {source: "qwen", model: "host-model"},
                },
                permissions: {defaultMode: "ask"},
            };
            const loaded = loadHiCodeHostConfig({
                cwd,
                hicodeHome,
                fileSources: FILE_SOURCES,
                settingsOverrides,
            });

            settingsOverrides.permissions!.defaultMode = "full-access";
            context.windowTokens = 600_000;
            expect(loaded.configuration.settings.context).toEqual({windowTokens: 1_000_000, autoCompactTokenLimit: 900_000});
            expect(loaded.configuration.settings.models.primary.model).toBe(
                "host-model"
            );
            expect(loaded.configuration.settings.permissions.defaultMode).toBe(
                "ask"
            );
            expect(loaded.origins.primaryModel).toBe("host");
            expect(loaded.origins.permissionMode).toBe("host");
        });
    });

    test("Host Settings 未知字段 fail closed", async () => {
        await withTempProject(async (cwd) => {
            expectSDKErrorCode(
                () => loadHiCodeHostConfig({
                    cwd,
                    hicodeHome: join(cwd, "host-data"),
                    fileSources: FILE_SOURCES,
                    settingsOverrides: {
                        memory: {enabled: true, typo: true},
                    } as HiCodeSettingsFile,
                }),
                "invalid_settings"
            );
        });
    });
});

function expectSDKErrorCode(run: () => unknown, code: string): void {
    try {
        run();
        throw new Error(`expected HiCodeSDKError ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(HiCodeSDKError);
        if (!(error instanceof HiCodeSDKError)) return;
        expect(error.code).toBe(code);
    }
}
