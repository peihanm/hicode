import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    DEFAULT_MODEL,
    loadPillarSettings,
    resolvePillarSettings,
    type LoadedSettingsDocument,
} from "../../src/settings/index.js";
import {DEFAULT_LLM_PROVIDER} from "../../src/llm/providerRegistry.js";
import {withTempProject} from "../helpers/tempProject.js";

function document(
    source: LoadedSettingsDocument["source"],
    value: LoadedSettingsDocument["value"]
): LoadedSettingsDocument {
    return {source, value, path: `/${source}/settings.json`};
}

describe("Unified Settings", () => {
    test("默认值保持现有模型和官方 GLM Provider", () => {
        const resolved = resolvePillarSettings([]);
        expect(resolved.values).toMatchObject({
            models: {
                primary: {
                    model: DEFAULT_MODEL,
                    provider: DEFAULT_LLM_PROVIDER,
                },
                fast: {model: "glm-4.7", provider: DEFAULT_LLM_PROVIDER},
            },
            permissions: {defaultMode: "default"},
        });
        expect(resolved.values.permissions.rules).toEqual({
            allow: [],
            ask: [],
            deny: [],
        });
        expect(resolved.values.sandbox).toEqual({
            enabled: false,
            filesystem: {
                allowWrite: ["."],
                denyRead: ["~/.ssh", "~/.aws", "~/.config/gcloud"],
                denyWrite: [".pillar", ".env"],
            },
            network: {
                allowedDomains: [],
                allowLocalBinding: false,
            },
        });
    });

    test("Settings 接受 Qwen、DeepSeek 与独立 Provider 模型", () => {
        const resolved = resolvePillarSettings([
            document("project", {
                models: {
                    primary: {provider: "qwen", model: "qwen3.6-plus"},
                    fast: {
                        provider: "deepseek",
                        model: "deepseek-v4-flash",
                    },
                },
            }),
        ]);
        expect(resolved.values.models.primary).toEqual({
            provider: "qwen",
            model: "qwen3.6-plus",
        });
        expect(resolved.values.models.fast).toEqual({
            provider: "deepseek",
            model: "deepseek-v4-flash",
        });
    });

    test("文件、环境和 CLI 按明确优先级合并", () => {
        const resolved = resolvePillarSettings(
            [
                document("user", {
                    models: {
                        primary: {model: "user-model", provider: "glm"},
                        fast: {model: "user-fast", provider: "glm"},
                    },
                    permissions: {
                        defaultMode: "acceptEdits",
                        allow: ["read_file", "bash(git status:*)"],
                    },
                }),
                document("project", {
                    models: {primary: {model: "project-model"}},
                    permissions: {
                        allow: ["read_file"],
                        deny: ["bash(rm:*)"],
                    },
                }),
                document("local", {
                    models: {primary: {provider: "jeniya"}},
                    permissions: {defaultMode: "dontAsk"},
                }),
            ],
            {
                primary: {model: "env-model", provider: "glm"},
                fast: {model: "env-fast", provider: "qwen"},
            },
            {model: "cli-model", provider: "jeniya"}
        );

        expect(resolved.values.models.primary).toEqual({
            model: "cli-model",
            provider: "jeniya",
        });
        expect(resolved.values.models.fast).toEqual({
            model: "env-fast",
            provider: "qwen",
        });
        expect(resolved.values.permissions.defaultMode).toBe("dontAsk");
        expect(resolved.origins).toEqual({
            primaryModel: "cli",
            primaryProvider: "cli",
            fastModel: "environment",
            fastProvider: "environment",
            permissionMode: "local",
            memoryEnabled: "default",
          memoryAutoExtract: "default",
          checkpointingEnabled: "default",
          sandboxEnabled: "default",
        });
        expect(resolved.values.permissions.rules.allow).toEqual([
            {toolName: "read_file", source: "project"},
            {toolName: "bash", content: "git status:*", source: "user"},
        ]);
        expect(resolved.values.permissions.rules.deny).toEqual([
            {toolName: "bash", content: "rm:*", source: "project"},
        ]);
    });

    test("主力和快速模型允许使用不同 Provider", () => {
        const resolved = resolvePillarSettings(
            [],
            {
                primary: {provider: "qwen", model: "qwen3.6-plus"},
                fast: {provider: "jeniya", model: "glm-4.7"},
            },
        );

        expect(resolved.values.models.primary).toEqual({
            provider: "qwen",
            model: "qwen3.6-plus",
        });
        expect(resolved.values.models.fast).toEqual({
            provider: "jeniya",
            model: "glm-4.7",
        });
    });

    test("Memory 默认开启，任意来源关闭后不能被其他来源重新开启", () => {
        expect(resolvePillarSettings([]).values.memory).toEqual({
            enabled: true,
            autoExtract: true,
        });
        const resolved = resolvePillarSettings([
            document("user", {
                memory: {enabled: false, autoExtract: false},
            }),
            document("project", {
                memory: {enabled: true, autoExtract: true},
            }),
        ]);
        expect(resolved.values.memory).toEqual({
            enabled: false,
            autoExtract: false,
        });
        expect(resolved.origins.memoryEnabled).toBe("user");
        expect(resolved.origins.memoryAutoExtract).toBe("user");
    });

    test("Checkpoint 默认开启并按 user、project、local 顺序覆盖", () => {
        expect(resolvePillarSettings([]).values.checkpointing).toEqual({
            enabled: true,
        });
        const resolved = resolvePillarSettings([
            document("user", {checkpointing: {enabled: false}}),
            document("project", {checkpointing: {enabled: true}}),
            document("local", {checkpointing: {enabled: false}}),
        ]);
        expect(resolved.values.checkpointing).toEqual({enabled: false});
        expect(resolved.origins.checkpointingEnabled).toBe("local");
    });

    test("Sandbox 默认关闭，嵌套字段按来源覆盖且数组不做权限并集", () => {
        const resolved = resolvePillarSettings([
            document("user", {
                sandbox: {
                    enabled: true,
                    filesystem: {
                        allowWrite: [".", "~/shared"],
                        denyRead: ["~/.ssh"],
                    },
                    network: {
                        allowedDomains: ["registry.npmjs.org"],
                    },
                },
            }),
            document("project", {
                sandbox: {
                    filesystem: {
                        allowWrite: ["."],
                    },
                    network: {
                        allowedDomains: ["api.example.com"],
                        allowLocalBinding: true,
                    },
                },
            }),
            document("local", {
                sandbox: {enabled: false},
            }),
        ]);

        expect(resolved.values.sandbox).toEqual({
            enabled: false,
            filesystem: {
                allowWrite: ["."],
                denyRead: ["~/.ssh"],
                denyWrite: [".pillar", ".env"],
            },
            network: {
                allowedDomains: ["api.example.com"],
                allowLocalBinding: true,
            },
        });
        expect(resolved.origins.sandboxEnabled).toBe("local");
    });

    test("旧顶层 mode 不再影响权限模式", () => {
        expect(
            resolvePillarSettings([
                document("project", {
                    mode: "plan",
                    permissions: {defaultMode: "acceptEdits"},
                }),
            ]).values.permissions.defaultMode
        ).toBe("acceptEdits");
        expect(
            resolvePillarSettings([
                document("project", {mode: "plan"}),
            ]).values.permissions.defaultMode
        ).toBe("default");
    });

    test("Hooks 按 user、project、local 叠加并保留配置来源", () => {
        const resolved = resolvePillarSettings([
            document("user", {
                hooks: {
                    PreToolUse: [{
                        matcher: "read_file",
                        hooks: [{type: "command", command: "user-hook"}],
                    }],
                },
            }),
            document("project", {
                hooks: {
                    PreToolUse: [{
                        matcher: "grep",
                        hooks: [{type: "command", command: "project-hook"}],
                    }],
                },
            }),
            document("local", {
                hooks: {
                    SessionEnd: [{
                        hooks: [{type: "command", command: "local-hook"}],
                    }],
                },
            }),
        ]);

        expect(resolved.values.hooks.PreToolUse.map((item) => ({
            matcher: item.matcher,
            source: item.source,
            path: item.path,
        }))).toEqual([
            {
                matcher: "read_file",
                source: "user",
                path: "/user/settings.json",
            },
            {
                matcher: "grep",
                source: "project",
                path: "/project/settings.json",
            },
        ]);
        expect(resolved.values.hooks.SessionEnd[0]?.source).toBe("local");
    });

    test("损坏来源被跳过，未知字段被保留并报告", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, ".pillar");
            await mkdir(directory, {recursive: true});
            await writeFile(
                join(directory, "settings.json"),
                JSON.stringify({
                    models: {
                        primary: {
                            model: "project-model",
                            futureModel: true,
                        },
                        futureTarget: {},
                    },
                    mode: "plan",
                    futureField: {keep: true},
                    permissions: {futurePermission: true},
                    memory: {futureMemory: true},
                    checkpointing: {futureCheckpointing: true},
                    sandbox: {
                        futureSandbox: true,
                        filesystem: {futureFilesystem: true},
                        network: {futureNetwork: true},
                    },
                })
            );
            await writeFile(
                join(directory, "settings.local.json"),
                "{broken-json"
            );

            const loaded = loadPillarSettings(cwd, {
                model: "cli-model",
                provider: "glm",
            });
            expect(loaded.values.models.primary.model).toBe("cli-model");
            expect(loaded.values.permissions.defaultMode).toBe("default");
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "mode" &&
                        issue.severity === "warning" &&
                        issue.message.includes("未知 Settings 字段")
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.source === "project" &&
                        issue.field === "futureField" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "models.futureTarget" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "models.primary.futureModel" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "sandbox.futureSandbox" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "sandbox.filesystem.futureFilesystem" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.source === "project" &&
                        issue.field === "memory.futureMemory" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "checkpointing.futureCheckpointing" &&
                        issue.severity === "warning"
                )
            ).toBe(true);
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.source === "local" && issue.severity === "error"
                )
            ).toBe(true);
        });
    });
});
