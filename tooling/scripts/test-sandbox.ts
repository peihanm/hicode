import {spawnSync} from "node:child_process";

// The OS Sandbox has one Root Runtime owner per process. Run each sandbox
// integration file in its own process so files cannot compete for that lease.
const files = [
    "tests/integration/sandbox.test.ts",
    "tests/integration/sandboxConcurrent.test.ts",
    "tests/integration/sandboxNetwork.test.ts",
    "tests/integration/sandboxInstall.test.ts",
    "tests/integration/dotenvSandbox.test.ts",
    "tests/integration/scopedMemorySandbox.test.ts",
    "tests/integration/readOnlySearch.test.ts",
    "tests/integration/memoryBash.test.ts",
    "tests/integration/fileSuggestions.test.ts",
];

const runtimeDirectory = process.env.HICODE_LINUX_RUNTIME_DIR;
for (const file of files) {
    const result = spawnSync(process.execPath, ["test", file], {
        stdio: "inherit",
        env: {
            ...process.env,
            HICODE_RUN_SANDBOX_INTEGRATION: "1",
            // ASRT's lower-level Linux wrapper resolves bwrap/socat from PATH.
            ...(runtimeDirectory ? {PATH: `${runtimeDirectory}/bin:${process.env.PATH ?? ""}`} : {}),
        },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
