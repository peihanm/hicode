import {expect, test} from "bun:test";
import {linuxSandboxTools} from "../../src/sandbox/config.js";

test("installer helper directory selects exact binaries without consulting PATH", () => {
    expect(linuxSandboxTools("/opt/HiCode runtime/linux-runtime-v1-arm64")).toEqual({
        bwrapPath: "/opt/HiCode runtime/linux-runtime-v1-arm64/bin/bwrap",
        socatPath: "/opt/HiCode runtime/linux-runtime-v1-arm64/bin/socat",
    });
    // Nonexistent explicit files remain explicit, so dependency validation fails closed.
    expect(linuxSandboxTools("/missing/hicode-runtime").bwrapPath).toBe("/missing/hicode-runtime/bin/bwrap");
});

test.each(["", "relative/runtime", "/tmp/runtime\nother", "/tmp/runtime\0other"])("invalid runtime directory is not silently replaced by system tools: %j", path => {
    expect(() => linuxSandboxTools(path)).toThrow("absolute directory");
});
