import {describe, expect, test} from "bun:test";
import {
    createChildProcessEnvironment,
    mergeChildProcessEnvironment,
} from "../../src/runtime/childEnvironment.js";

describe("Child process environment", () => {
    test("保留普通变量并剔除配置凭证与常见 Secret", () => {
        const environment = createChildProcessEnvironment({
            PATH: "/bin",
            PILLAR_VISIBLE: "yes",
            CustomCredential: "configured-secret",
            GITHUB_TOKEN: "token-secret",
            SERVICE_PASSWORD: "password-secret",
        }, ["CUSTOMCREDENTIAL"]);

        expect(environment.base).toEqual({
            PATH: "/bin",
            PILLAR_VISIBLE: "yes",
        });
    });

    test("后续覆盖不能重新注入 Secret", () => {
        const environment = createChildProcessEnvironment(
            {PATH: "/bin"},
            ["CUSTOM_MODEL_CREDENTIAL"]
        );

        expect(mergeChildProcessEnvironment(environment, {
            PATH: "/usr/bin",
            SAFE_VALUE: "visible",
            CUSTOM_MODEL_CREDENTIAL: "configured-secret",
            SESSION_TOKEN: "token-secret",
        })).toEqual({
            PATH: "/usr/bin",
            SAFE_VALUE: "visible",
        });
    });
});
