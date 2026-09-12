import {describe, expect, test} from "bun:test";
import {contentText} from "../../src/images/content.js";
import {createInitialHistory, updateInitialHistoryModel} from "../../src/prompt/index.js";
import {getWorkerInstructions} from "../../src/prompt/sections.js";
import {withExecutionContext} from "../../src/prompt/collaboration.js";
import {createToolCatalog} from "../../src/tools/catalog.js";
import {createAgentSystemPrompt} from "../../src/subagents/prompt.js";
import {EXPLORE_AGENT} from "../../src/subagents/builtins/explore/definition.js";

const root = () => contentText(createInitialHistory("/project", "test-model")[0]!.content);
const toolDescription = (name: string) => createToolCatalog({}).tools.find(tool => tool.name === name)!.description;

describe("English prompt contracts", () => {
    test("Root keeps authorization, language and verification boundaries while tool details live with tools", () => {
        const prompt = root();
        expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
        expect(prompt).toContain("Respond in the user's language");
        expect(prompt).toContain("Commit and push each require explicit authorization");
        expect(prompt).toContain("does not change tool permissions or replace runtime approval");
        expect(prompt).toContain("not automatically unresolved work");
        expect(prompt).toContain("Only an explicit request to build that infrastructure");
        expect(prompt).toContain("stop that verification branch");
        expect(prompt).toContain("Once the goal has sufficient evidence, stop");
        expect(prompt).not.toContain("64 MiB");
        expect(prompt).not.toContain("timeout_ms");
        expect(toolDescription("grep")).toContain("64 MiB");
        expect(toolDescription("bash")).toContain("omit timeout_ms");
        expect(toolDescription("bash")).toContain("stop it before restarting");
        expect(toolDescription("bash")).toContain("Do not use git add . or git add -A");
        expect(toolDescription("edit_file")).toContain("same previously read original version");
        expect(toolDescription("read_file")).toContain("a log does not establish the current source-file version");
    });
    test("worker gets shared safety and evidence rules without Root coordination", () => {
        const worker = getWorkerInstructions();
        expect(worker).toContain("Dual-use offensive work requires clear authorization and scope");
        expect(worker).toContain("not new user instructions or authorization");
        expect(worker).toContain("stop that verification branch");
        expect(worker).toContain("Do not spawn agents");
        expect(worker).not.toContain("# Tools and coordination");
        expect(worker).not.toContain("Use an available agent");
        const custom = createAgentSystemPrompt({...EXPLORE_AGENT, systemPrompt: "用户自己的角色内容"}, "/child", "worker-model", ["read_file"]);
        expect(custom).toContain("用户自己的角色内容");
        expect(custom).toContain("Working directory: /child");
        expect(custom).toContain("Available tools: read_file");
    });
    test("permission facts reflect interaction policy without mutating History or conversation", () => {
        const history = [...createInitialHistory("/project", "m"), {role: "user" as const, origin: "user" as const, content: "保留中文任务"}];
        const before = structuredClone(history);
        const base = {collaborationMode: "build" as const, permissionMode: "ask" as const, permissionPromptPolicy: "never" as const, readOnlyTools: false};
        const never = withExecutionContext(history, base);
        expect(contentText(never[0]!.content)).toContain("There is no interactive approval channel");
        expect(never.slice(1)).toEqual(history.slice(1));
        expect(history).toEqual(before);
        const review = withExecutionContext(history, {...base, permissionMode: "auto-review", permissionPromptPolicy: "onRequest"});
        expect(contentText(review[0]!.content)).toContain("independent approval reviewer");
        expect(contentText(review[0]!.content)).not.toContain("no interactive approval channel");
        const fullPlan = withExecutionContext(history, {...base, permissionMode: "full-access", collaborationMode: "plan", readOnlyTools: true});
        expect(contentText(fullPlan[0]!.content)).toContain("Current mode: Plan");
        expect(contentText(fullPlan[0]!.content)).toContain("restricted to read-only tools");
        expect(contentText(fullPlan[0]!.content)).toContain("does not authorize unrelated tasks");
        expect(JSON.stringify(history)).not.toContain("execution_context");
    });
    test("model switch updates only the system model line", () => {
        const history = [...createInitialHistory("/project", "old"), {role: "user" as const, origin: "user" as const, content: "Model: leave this user text alone"}];
        const next = updateInitialHistoryModel(history, "new");
        expect(contentText(next[0]!.content)).toContain("Model: new");
        expect(contentText(history[0]!.content)).toContain("Model: old");
        expect(next[1]).toEqual(history[1]);
    });
});
