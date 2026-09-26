import {describe, expect, test} from "bun:test";
import {
    createChildProcessEnvironment,
    mergeChildProcessEnvironment,
} from "../../src/runtime/childEnvironment.js";

describe("Child process environment", () => {
    test.each(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])("Node honors configured %s without changing exclusions", name => {
        const env = createChildProcessEnvironment({[name]: "http://127.0.0.1:1234", NO_PROXY: "localhost"}, []);
        expect(mergeChildProcessEnvironment(env)).toMatchObject({NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost"});
        expect(env.base.NODE_USE_ENV_PROXY).toBeUndefined();
        expect(mergeChildProcessEnvironment(env, {NODE_USE_ENV_PROXY: "0"}).NODE_USE_ENV_PROXY).toBe("0");
        expect(mergeChildProcessEnvironment(env, {[name]: ""}).NODE_USE_ENV_PROXY).toBeUndefined();
    });

    test("proxy defaults apply after overrides and secret filtering", () => {
        const env = createChildProcessEnvironment({}, []);
        expect(mergeChildProcessEnvironment(env).NODE_USE_ENV_PROXY).toBeUndefined();
        expect(mergeChildProcessEnvironment(env, {HTTPS_PROXY: "http://127.0.0.1:1234"}).NODE_USE_ENV_PROXY).toBe("1");
        const excluded = createChildProcessEnvironment({HTTPS_PROXY: "secret"}, ["HTTPS_PROXY"]);
        expect(mergeChildProcessEnvironment(excluded, {HTTPS_PROXY: "secret"})).toEqual({});
        expect(mergeChildProcessEnvironment(createChildProcessEnvironment({HTTP_PROXY: "http://localhost"}, ["NODE_USE_ENV_PROXY"])).NODE_USE_ENV_PROXY).toBeUndefined();
    });
    test("保留普通变量并剔除配置凭证与常见 Secret", () => {
        const environment = createChildProcessEnvironment({
            PATH: "/bin",
            HICODE_VISIBLE: "yes",
            CustomCredential: "configured-secret",
            GITHUB_TOKEN: "token-secret",
            SERVICE_PASSWORD: "password-secret",
        }, ["CUSTOMCREDENTIAL"]);

        expect(environment.base).toEqual({
            PATH: "/bin",
            HICODE_VISIBLE: "yes",
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
