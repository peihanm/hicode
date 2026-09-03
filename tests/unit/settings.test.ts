import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    DEFAULT_MODEL,
    loadPillarSettings,
    resolvePillarSettings,
    type LoadedSettingsDocument,
    type SettingsFileSource,
    type PillarSettingsFile,
} from "../../src/settings/index.js";
import {DEFAULT_LLM_PROVIDER} from "../../src/llm/providerRegistry.js";
import {withTempProject} from "../helpers/tempProject.js";

function document(
    source: SettingsFileSource,
    value: LoadedSettingsDocument["value"]
): LoadedSettingsDocument {
    return {source, value, path: `/${source}/settings.json`};
}

describe("Unified Settings", () => {
    test("primary 和 fast 默认使用 Qwen 3.8 Flash", () => {
        const resolved = resolvePillarSettings([]);
        expect(resolved.values).toMatchObject({
            models: {
                primary: {
                    model: DEFAULT_MODEL,
                    source: DEFAULT_LLM_PROVIDER,
                    provider: DEFAULT_LLM_PROVIDER,
                    label: "Qwen 3.8 Flash",
                },
                fast: {
                    model: DEFAULT_MODEL,
                    source: DEFAULT_LLM_PROVIDER,
                    provider: DEFAULT_LLM_PROVIDER,
                    label: "Qwen 3.8 Flash",
                },
            },
            permissions: {defaultMode: "default"},
        });
        expect(resolved.values.permissions.rules).toEqual({
            allow: [],
            ask: [],
            deny: [],
        });
        expect(resolved.values.sandbox).toEqual({
            enabled: true,
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

    test("Settings 用 source/model 选择目录中的 Qwen 与 DeepSeek 模型", () => {
        const resolved = resolvePillarSettings([
            document("project", {
                models: {
                    primary: {source: "qwen", model: "qwen3.6-plus"},
                    fast: {
                        source: "deepseek",
                        model: "deepseek-v4-flash",
                    },
                },
            }),
        ]);
        expect(resolved.values.models.primary).toEqual({
            provider: "qwen",
            source: "qwen",
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        });
        expect(resolved.values.models.fast).toEqual({
            provider: "deepseek",
            source: "deepseek",
            model: "deepseek-v4-flash",
            label: "DeepSeek V4 Flash",
        });
    });

    test("文件和 CLI 按明确优先级合并", () => {
        const resolved = resolvePillarSettings(
            [
                document("user", {
                    models: {
                        primary: {model: "glm-5.2", source: "glm"},
                        fast: {model: "glm-4.7", source: "glm"},
                    },
                    permissions: {
                        defaultMode: "default",
                        allow: ["read_file", "bash(git status:*)"],
                    },
                }),
                document("project", {
                    models: {
                        primary: {model: "qwen3.6-plus", source: "qwen"},
                        fast: {model: "qwen3.6-flash", source: "qwen"},
                    },
                    permissions: {
                        allow: ["read_file"],
                        deny: ["bash(rm:*)"],
                    },
                }),
                document("local", {
                    models: {primary: {model: "glm-4.7", source: "glm"}},
                    permissions: {defaultMode: "readOnly"},
                }),
            ],
            {model: "deepseek-v4-pro", source: "deepseek"}
        );

        expect(resolved.values.models.primary).toEqual({
            source: "deepseek",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            label: "DeepSeek V4 Pro",
        });
        expect(resolved.values.models.fast).toEqual({
            source: "qwen",
            provider: "qwen",
            model: "qwen3.6-flash",
            label: "Qwen 3.6 Flash",
        });
        expect(resolved.values.permissions.defaultMode).toBe("readOnly");
        expect(resolved.origins).toEqual({
            primaryModel: "cli",
            primarySource: "cli",
            fastModel: "project",
            fastSource: "project",
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

    test("主力和快速模型允许使用不同 source", () => {
        const resolved = resolvePillarSettings([
            document("project", {
                models: {
                    primary: {source: "qwen", model: "qwen3.6-plus"},
                    fast: {source: "deepseek", model: "deepseek-v4-flash"},
                },
            }),
        ]);

        expect(resolved.values.models.primary).toEqual({
            provider: "qwen",
            source: "qwen",
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        });
        expect(resolved.values.models.fast).toEqual({
            provider: "deepseek",
            source: "deepseek",
            model: "deepseek-v4-flash",
            label: "DeepSeek V4 Flash",
        });
    });

    test("source 目录只接受用户级定义，项目只能选择模型", () => {
        const resolved = resolvePillarSettings([
            document("user", {
                sources: {
                    qwen: {
                        label: "自定义百炼",
                        apiKeyEnv: "CUSTOM_QWEN_API_KEY",
                        baseUrl: "https://relay.example/v1",
                        models: [
                            {id: "qwen3.8-flash", label: "Qwen 3.8 Flash"},
                        ],
                    },
                },
            }),
            document("project", {
                sources: {
                    qwen: {
                        apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
                        baseUrl: "https://untrusted.example/v1",
                    },
                },
                models: {
                    primary: {source: "qwen", model: "qwen3.8-flash"},
                },
            }),
        ]);

        expect(resolved.values.sources.qwen).toMatchObject({
            label: "自定义百炼",
            apiKeyEnv: "CUSTOM_QWEN_API_KEY",
            baseUrl: "https://relay.example/v1",
        });
        expect(resolved.values.models.primary).toMatchObject({
            source: "qwen",
            model: "qwen3.8-flash",
            label: "Qwen 3.8 Flash",
        });
        expect(resolved.values.models.fast).toMatchObject({
            source: "qwen",
            model: "qwen3.8-flash",
            label: "Qwen 3.8 Flash",
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

    test("Sandbox 默认开启，嵌套字段按来源覆盖且允许显式关闭", () => {
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
                    permissions: {defaultMode: "default"},
                } as PillarSettingsFile),
            ]).values.permissions.defaultMode
        ).toBe("default");
        expect(
            resolvePillarSettings([
                document("project", {mode: "plan"} as PillarSettingsFile),
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
            path: item.source === "host" ? item.id : item.path,
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
        await withTempProject(async (cwd, storage) => {
            const directory = join(cwd, ".pillar");
            await mkdir(directory, {recursive: true});
            await writeFile(
                join(directory, "settings.json"),
                JSON.stringify({
                    models: {
                        primary: {
                            model: "glm-5.2",
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

            const loaded = loadPillarSettings({
                storage,
                cwd,
                cliOverrides: {
                    model: "glm-4.7",
                    source: "glm",
                },
            });
            expect(loaded.values.models.primary.model).toBe("glm-4.7");
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
