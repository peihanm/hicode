import {createMcpManager} from "../../../src/mcp/manager.js";
import {createHiCodeStorageLayout} from "../../../src/persistence/layout.js";
import {createChildProcessEnvironment} from "../../../src/runtime/childEnvironment.js";
import {createToolRuntime} from "../../../src/tools/runtime.js";
import {createTestContext} from "../../helpers/testContext.js";

const [cwd, url] = process.argv.slice(2);
if (!cwd || !url) throw new Error("Missing fixture arguments");
const manager = createMcpManager({
    cwd, storage: createHiCodeStorageLayout({hicodeHome: `${cwd}/storage`}),
    sources: [], childEnvironment: createChildProcessEnvironment({}, []),
    hostServers: [{name: "remote", url, timeoutMs: 1000}], requestApproval: async () => "trust-tools",
});
try {
    await manager.initialize();
    // Exceed the child process's one-second socket idle timeout and startup deadline.
    await Bun.sleep(6000);
    if (manager.getSnapshots()[0]?.status !== "connected" || manager.getTools().length !== 1) {
        throw new Error("Idle notification stream lost its connection or tools");
    }
    const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
    const ctx = createTestContext(cwd, {mcpManager: manager});
    runtime.getToolSchemas();
    await runtime.executeTool("tool_search", '{"query":"select:mcp__remote__echo"}', ctx, "discover");
    runtime.getToolSchemas();
    const result = await runtime.executeTool("mcp__remote__echo", "{}", ctx, "after-idle");
    if (result.outcome !== "ok" || !JSON.stringify(result).includes("HTTP fixture result")) {
        throw new Error("Tool call failed after idle period");
    }
    console.log("IDLE_CONNECTION_OK");
} finally {
    await manager.closeAll();
}
