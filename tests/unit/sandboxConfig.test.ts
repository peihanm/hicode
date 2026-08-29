import {describe, expect, test} from "bun:test";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {createSandboxRuntimeConfig} from "../../src/sandbox/index.js";

describe("Sandbox config", () => {
    test("把项目路径和 home 路径规范化为绝对路径", () => {
        const cwd = "/tmp/pillar-sandbox-project";
        const config = createSandboxRuntimeConfig(cwd, {
            enabled: true,
            filesystem: {
                allowWrite: [".", "output"],
                denyRead: ["~/.ssh"],
                denyWrite: ["secrets"],
            },
            network: {
                allowedDomains: ["api.example.com"],
                allowLocalBinding: true,
            },
        });

        expect(config.filesystem.allowWrite).toEqual([
            resolve(cwd),
            resolve(cwd, "output"),
        ]);
        expect(config.filesystem.denyRead).toEqual([
            join(homedir(), ".ssh"),
        ]);
        expect(config.filesystem.denyWrite).toContain(
            resolve(cwd, "secrets")
        );
        expect(config.network).toMatchObject({
            allowedDomains: ["api.example.com"],
            deniedDomains: [],
            allowLocalBinding: true,
        });
    });

    test("Pillar 管理目录和 .env 始终保持禁止写入", () => {
        const cwd = "/tmp/pillar-sandbox-project";
        const config = createSandboxRuntimeConfig(cwd, {
            enabled: true,
            filesystem: {
                allowWrite: ["."],
                denyRead: [],
                denyWrite: [],
            },
            network: {
                allowedDomains: [],
                allowLocalBinding: false,
            },
        });

        expect(config.filesystem.denyWrite).toContain(resolve(cwd, ".pillar"));
        expect(config.filesystem.denyWrite).toContain(resolve(cwd, ".env"));
    });
});
