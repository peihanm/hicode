import {expect, test} from "bun:test";
import {macOSSandboxArgv} from "../../src/sandbox/macos.js";
import {wrapCommandWithSandboxMacOS} from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {createSandboxRuntimeConfig} from "../../src/sandbox/config.js";
import {hicodeHostSettingsSchema, hicodeSettingsFileSchema} from "../../src/settings/schema.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";

test("Unix Socket settings reject relative paths, wildcards and control characters", () => {
    for (const schema of [hicodeHostSettingsSchema, hicodeSettingsFileSchema]) {
        for (const path of ["socket", "~/socket", "/tmp/*", "/tmp/a?", "/tmp/a\n.sock", "/tmp/a\0.sock"]) {
            expect(schema.safeParse({sandbox: {network: {allowUnixSockets: [path]}}}).success).toBe(false);
        }
        expect(schema.safeParse({sandbox: {network: {allowUnixSockets: ["/tmp/a ' 中文.sock"]}}}).success).toBe(true);
    }
});

test("Socket grants replace earlier settings, and an empty list revokes them", () => {
    const user = {source: "user" as const, path: "/user/settings.json", value: {sandbox: {network: {allowUnixSockets: ["/tmp/a.sock"]}}}};
    const local = {source: "local" as const, path: "/project/.hicode/settings.local.json", value: {sandbox: {network: {allowUnixSockets: ["/tmp/b.sock"]}}}};
    expect(resolveHiCodeSettings([user, local]).values.sandbox.network.allowUnixSockets).toEqual(["/tmp/b.sock"]);
    expect(resolveHiCodeSettings([user, {...local, value: {sandbox: {network: {allowUnixSockets: []}}}}]).values.sandbox.network.allowUnixSockets).toEqual([]);
});

test.skipIf(process.platform === "darwin")("unsupported platforms reject socket exceptions instead of disabling socket protection", () => {
    expect(() => createSandboxRuntimeConfig("/tmp/work", {
        filesystem: {denyRead: [], denyWrite: []},
        network: {mode: "open", allowedDomains: [], allowLocalBinding: false, allowUnixSockets: ["/tmp/a.sock"]},
    })).toThrow("require macOS");
});

test("macOS wrapper preserves quoted paths and commands as data", () => {
    const command = "printf '%s\\n' \"$(echo hi)\" 'a!中文' `echo literal`\n# /usr/bin/sandbox-exec -p '(allow default)'";
    const socketPath = '/tmp/a " quoted.sock';
    const argv = macOSSandboxArgv(wrapCommandWithSandboxMacOS({command, binShell: "/bin/bash", needsNetworkRestriction: false,
        readConfig: {denyOnly: ["/tmp/secrets ' 中文"]}, writeConfig: {allowOnly: ["/tmp/work ' 中文"], denyWithinAllow: []},
    }), command, [socketPath]);
    const index = argv.indexOf("/usr/bin/sandbox-exec");
    expect(argv.slice(index + 3)).toEqual(["/bin/bash", "-c", command]);
    const profile = argv[index + 2]!;
    expect(profile).toContain("(allow network*)");
    expect(profile).toContain(`(require-all (remote unix-socket) (require-not (remote unix-socket (literal ${JSON.stringify(socketPath)}))))`);
    expect(profile).toContain("/tmp/secrets ' 中文");
});

test("unexpected wrapper formats fail closed instead of executing an unprotected command", () => {
    for (const wrapped of ["true", "env /usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c true; echo unsafe", "env /usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c wrong"]) {
        expect(() => macOSSandboxArgv(wrapped, "true", [])).toThrow();
    }
});
