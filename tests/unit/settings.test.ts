import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    DEFAULT_MODEL,
    loadHiCodeSettings,
    resolveHiCodeSettings,
    type LoadedSettingsDocument,
    type SettingsFileSource,
    type HiCodeSettingsFile,
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
    test("primary 默认 Qwen，未声明 fast 时保留跟随语义", () => {
        const resolved = resolveHiCodeSettings([]);
        expect(resolved.values).toMatchObject({
            models: {
                primary: {
                    model: DEFAULT_MODEL,
                    source: DEFAULT_LLM_PROVIDER,
                    label: "Qwen 3.8 Flash",
                },
            },
            permissions: {defaultMode: "ask"},
        });
        expect(resolved.values.permissions.rules).toEqual({
            allow: [],
            ask: [],
            deny: [],
        });
        expect(resolved.values.sandbox).toEqual({
                        filesystem: {
                denyRead: ["~/.ssh", "~/.aws", "~/.config/gcloud"],
                denyWrite: [".hicode", ".env"],
            },
            network: {
                mode: "open", allowedDomains: [],
                allowLocalBinding: true,
            },
        });
    });

    test("Settings 用 source/model 选择目录中的 Qwen 与 DeepSeek 模型", () => {
        const resolved = resolveHiCodeSettings([
            document("project", {
                models: {
                    primary: {source: "qwen", model: "qwen3.6-plus"},
                    fast: {
                        source: "deepseek",
                        model: "deepseek-flash",
                    },
                },
            }),
        ]);
        expect(resolved.values.models.primary).toEqual({
            source: "qwen",
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        });
        expect(resolved.values.models.fast).toEqual({
            source: "deepseek",
            model: "deepseek-flash",
            label: "DeepSeek Flash",
        });
    });

    test("文件和 CLI 按明确优先级合并", () => {
        const resolved = resolveHiCodeSettings(
            [
                document("user", {
                    models: {
                        primary: {model: "glm-5.2", source: "glm"},
                        fast: {model: "glm-4.7", source: "glm"},
                    },
                    permissions: {
                        defaultMode: "ask",
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
                    permissions: {defaultMode: "ask"},
                }),
            ],
            {model: "deepseek-pro", source: "deepseek"}
        );

        expect(resolved.values.models.primary).toEqual({
            source: "deepseek",
            model: "deepseek-pro",
            label: "DeepSeek Pro",
        });
        expect(resolved.values.models.fast).toEqual({
            source: "qwen",
            model: "qwen3.6-flash",
            label: "Qwen 3.6 Flash",
        });
        expect(resolved.values.permissions.defaultMode).toBe("ask");
        expect(resolved.origins).toEqual({
            primaryModel: "cli",
            primarySource: "cli",
            fastModel: "project",
            fastSource: "project",
            permissionMode: "local",
            memoryEnabled: "default",
          memoryAutoExtract: "default",
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
        const resolved = resolveHiCodeSettings([
            document("project", {
                models: {
                    primary: {source: "qwen", model: "qwen3.6-plus"},
                    fast: {source: "deepseek", model: "deepseek-flash"},
                },
            }),
        ]);

        expect(resolved.values.models.primary).toEqual({
            source: "qwen",
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        });
        expect(resolved.values.models.fast).toEqual({
            source: "deepseek",
            model: "deepseek-flash",
            label: "DeepSeek Flash",
        });
    });

    test("source 目录只接受用户级定义，项目只能选择模型", () => {
        const resolved = resolveHiCodeSettings([
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
        expect(resolved.values.models.fast).toBeUndefined();
    });

    test("Memory 召回默认开启、自动生成默认关闭，显式关闭不能被覆盖", () => {
        expect(resolveHiCodeSettings([]).values.memory).toEqual({
            enabled: true,
            autoExtract: false,
        });
        const resolved = resolveHiCodeSettings([
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

    test("目录授权按来源合并去重且与 Sandbox 配置分离", () => {
        const resolved = resolveHiCodeSettings([
            document("user", {
                permissions: {additionalDirectories: ["/shared/a"]},
            }),
            document("project", {
                permissions: {
                    additionalDirectories: ["/shared/a", "/shared/b"],
                },
            }),
        ]);

        expect(resolved.values.permissions.additionalDirectories).toEqual([
            "/shared/a",
            "/shared/b",
        ]);
        expect(resolved.values.sandbox.filesystem).not.toHaveProperty("allowWrite");
    });

    test("Sandbox 默认开启，安全字段按来源覆盖且允许显式关闭", () => {
        const resolved = resolveHiCodeSettings([
            document("user", {
                sandbox: {

                    filesystem: {
                        denyRead: ["~/.ssh"],
                    },
                    network: {
                        mode: "restricted", allowedDomains: ["registry.npmjs.org"],
                    },
                },
            }),
            document("project", {
                sandbox: {
                    network: {
                        mode: "restricted", allowedDomains: ["api.example.com"],
                        allowLocalBinding: true,
                    },
                },
            }),
            document("local", {
                sandbox: {},
            }),
        ]);

        expect(resolved.values.sandbox).toEqual({
                        filesystem: {
                denyRead: ["~/.ssh"],
                denyWrite: [".hicode", ".env"],
            },
            network: {
                mode: "restricted", allowedDomains: ["api.example.com"],
                allowLocalBinding: true,
            },
        });
    });

    test("旧顶层 mode 不再影响权限模式", () => {
        expect(
            resolveHiCodeSettings([
                document("project", {
                    mode: "plan",
                    permissions: {defaultMode: "ask"},
                } as HiCodeSettingsFile),
            ]).values.permissions.defaultMode
        ).toBe("ask");
        expect(
            resolveHiCodeSettings([
                document("project", {mode: "plan"} as HiCodeSettingsFile),
            ]).values.permissions.defaultMode
        ).toBe("ask");
    });

    test("Hooks 按 user、project、local 叠加并保留配置来源", () => {
        const resolved = resolveHiCodeSettings([
            document("user", {
                hooks: {
                    PreToolUse: [{
                        matcher: "read_file",
                        hooks: [{type: "command", purpose: "observe", command: "user-hook"}],
                    }],
                },
            }),
            document("project", {
                hooks: {
                    PreToolUse: [{
                        matcher: "bash",
                        hooks: [{type: "command", purpose: "observe", command: "project-hook"}],
                    }],
                },
            }),
            document("local", {
                hooks: {
                    SessionEnd: [{
                        hooks: [{type: "command", purpose: "observe", command: "local-hook"}],
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
                matcher: "bash",
                source: "project",
                path: "/project/settings.json",
            },
        ]);
        expect(resolved.values.hooks.SessionEnd[0]?.source).toBe("local");
    });

    test("损坏来源被跳过，未知字段被保留并报告", async () => {
        await withTempProject(async (cwd, storage) => {
            const directory = join(cwd, ".hicode");
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

            const loaded = loadHiCodeSettings({
                storage,
                cwd,
                cliOverrides: {
                    model: "glm-4.7",
                    source: "glm",
                },
            });
            expect(loaded.values.models.primary.model).toBe("glm-4.7");
            expect(loaded.values.permissions.defaultMode).toBe("ask");
            expect(
                loaded.issues.some(
                    (issue) =>
                        issue.field === "mode" &&
                        issue.severity === "warning" &&
                        issue.message.includes("Unknown Settings field")
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
                        issue.field === "checkpointing" &&
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

test("context 默认 50 万窗口、45 万压缩，可由各层分别覆盖", () => {
    expect(resolveHiCodeSettings([]).values.context).toEqual({windowTokens: 500_000, autoCompactTokenLimit: 450_000});
    const resolved = resolveHiCodeSettings([
        document("user", {context: {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000}}),
        document("project", {context: {autoCompactTokenLimit: 800_000}}),
        document("local", {context: {autoCompactTokenLimit: 750_000}}),
        {source: "host", id: "host", value: {context: {autoCompactTokenLimit: 700_000}}},
    ]);
    expect(resolved.values.context).toEqual({windowTokens: 1_000_000, autoCompactTokenLimit: 700_000});
    expect(() => resolveHiCodeSettings([document("user", {context: {windowTokens: 100_000}})])).toThrow("input budget");
});

test("非法 context 不静默回退到默认，Host 同样校验", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, ".hicode"), {recursive: true});
        for (const context of [{windowTokens: -1}, {windowTokens: 1.5}, {autoCompactTokenLimit: 0}, {windowTokens: "500000"}, {typo: 10}]) {
            await writeFile(join(cwd, ".hicode/settings.json"), JSON.stringify({context}));
            expect(() => loadHiCodeSettings({storage, cwd, sources: ["project"]})).toThrow("Invalid context configuration");
        }
        await writeFile(join(cwd, ".hicode/settings.json"), JSON.stringify({context: {windowTokens: 1_000_000}}));
        const loaded = loadHiCodeSettings({storage, cwd, sources: ["project"], hostSettings: {context: {autoCompactTokenLimit: 800_000}}});
        expect(loaded.values.context).toEqual({windowTokens: 1_000_000, autoCompactTokenLimit: 800_000});
        expect(loaded.issues).toEqual([]);
        expect(() => loadHiCodeSettings({storage, cwd, sources: [], hostSettings: {context: {autoCompactTokenLimit: -1}}})).toThrow("Invalid context configuration");
    });
});


test("network mode follows explicit settings precedence without changing permissions", () => {
    const resolved = resolveHiCodeSettings([
        document("user", {sandbox: {network: {mode: "open"}}}),
        document("project", {sandbox: {network: {allowedDomains: ["example.com"]}}}),
        document("local", {sandbox: {network: {mode: "restricted"}}}),
    ]);
    expect(resolved.values.sandbox.network).toMatchObject({mode: "restricted", allowedDomains: ["example.com"]});
    expect(resolveHiCodeSettings([document("local", {sandbox: {network: {mode: "open"}}})]).values.permissions.defaultMode).toBe("ask");
});
