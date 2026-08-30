import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    loadPillarHostConfig,
    PillarSDKError,
} from "../../src/sdk/index.js";
import {withTempProject} from "../helpers/tempProject.js";

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
                source: "qwen",
                model: "host-qwen",
            });

            expect(loaded.pillarOptions.cwd).toBe(cwd);
            expect(loaded.pillarOptions.storage.pillarHome).toBe(pillarHome);
            expect(loaded.pillarOptions.settings.models.primary).toEqual({
                source: "qwen",
                provider: "qwen",
                model: "host-qwen",
                label: "Host Qwen",
            });
            expect(loaded.pillarOptions.settings.permissions.defaultMode).toBe(
                "acceptEdits"
            );
            expect(loaded.pillarOptions.settings.checkpointing.enabled).toBe(
                false
            );
            expect(loaded.pillarOptions.settings.memory.enabled).toBe(false);
            expect(loaded.origins.primaryModel).toBe("cli");
            expect(loaded.issues).toEqual([]);
        });
    });

    test("损坏的 Host Settings fail closed 并抛出类型化错误", async () => {
        await withTempProject(async (cwd) => {
            const pillarHome = join(cwd, "host-data");
            await mkdir(pillarHome, {recursive: true});
            await writeFile(join(pillarHome, "settings.json"), "{broken-json");

            expect(() => loadPillarHostConfig({cwd, pillarHome})).toThrow(
                PillarSDKError
            );
            try {
                loadPillarHostConfig({cwd, pillarHome});
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
                    source: "qwen",
                    model: "missing-model",
                }),
                "invalid_settings"
            );
            expectSDKErrorCode(
                () => loadPillarHostConfig({cwd, pillarHome: "relative-home"}),
                "invalid_pillar_home"
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
