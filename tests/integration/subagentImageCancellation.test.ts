import {expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import sharp from "sharp";
import {createSubagentFactories} from "../../src/subagents/runSubagent.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import type {AgentRunner} from "../../src/agent/index.js";
import type {Message} from "../../src/llm/types.js";
import {prepareImage} from "../../src/images/prepare.js";
import {persistPreparedImage} from "../../src/images/persist.js";
import {createImageAccess} from "../../src/images/access.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

test.each(["parent", "child"])("image inheritance follows the child run signal when %s is cancelled", async cancelled => {
    await withTempProject(async cwd => {
        const parentSignal = new AbortController(), childSignal = new AbortController();
        const parent = createTestContext(cwd, {signal: parentSignal.signal});
        const raw = await sharp({create: {width: 2, height: 2, channels: 3, background: {r: 20, g: 80, b: 160}}}).png().toBuffer();
        const prepared = await prepareImage(raw, childSignal.signal);
        const ref = await persistPreparedImage({store: parent.toolResultStore, origin: {kind: "user", inputId: randomUUID()},
            sourceData: raw, prepared, signal: childSignal.signal});
        const history: Message[] = [{role: "system", content: "fixture"}, {role: "user", origin: "user", content: [ref]}];
        const access = createImageAccess({storage: parent.storage, store: parent.toolResultStore, history: () => history, state: () => parent.compactState});
        parent.imageAccess = {...access, async readSource(reference) {
            const bytes = await access.readSource(reference);
            (cancelled === "parent" ? parentSignal : childSignal).abort("user-cancel");
            return bytes;
        }};
        let entered = false;
        const runner: AgentRunner = async () => {entered = true; return {reply: "done", reason: "completed", iterations: 1};};
        const factories = createSubagentFactories({primaryRunAgent: runner, registry: BUILTIN_SUBAGENT_REGISTRY,
            createToolResultStore: (ownerCwd, id) => createTestToolResultStore(ownerCwd, id)});
        const thread = factories.createSubagentThread({parentContext: parent, agentId: "images", onEvent() {}},
            {agentType: "Worker", name: "images", description: "fixture", prompt: "fixture", parentToolCallId: "spawn", contextSnapshot: {history}});
        const run = thread.run({prompt: "fixture", signal: childSignal.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        if (cancelled === "child") await expect(run).rejects.toThrow("interrupted");
        else expect((await run).reply).toBe("done");
        expect(entered).toBe(cancelled === "parent");
    });
});
