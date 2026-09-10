import type {SandboxRuntimeLike} from "../../src/sandbox/types.js";
export function createDisabledSandboxRuntime(): SandboxRuntimeLike {
    return {status: {kind: "ready", platform: "macos", warnings: []},
        async wrapCommand(command) {return {argv: ["/bin/bash", "-o", "pipefail", "-c", command], env: {}};},
        annotateStderr: (_command, stderr) => stderr, cleanupAfterCommand() {}, async close() {},
    };
}
