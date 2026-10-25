import {describe, expect, test} from "bun:test";
import {contentText} from "../../src/images/content.js";
import {createInitialHistory, createSubagentInstructions} from "../../src/prompt/index.js";
import {withExecutionContext} from "../../src/prompt/messages.js";
import {createToolCatalog} from "../../src/tools/catalog.js";
import {createAgentSystemPrompt} from "../../src/subagents/prompt.js";
import {EXPLORE_SUBAGENT} from "../../src/subagents/builtins/explore/index.js";
const EXPLORE_AGENT = EXPLORE_SUBAGENT.definition;

const root = () => contentText(createInitialHistory("/project")[0]!.content);
const toolDescription = (name: string) => createToolCatalog({}).tools.find(tool => tool.name === name)!.description;

describe("English prompt contracts", () => {
    test("environment reports the execution shell rather than the user's login shell", () => {
        const previous = process.env.SHELL;
        try {
            process.env.SHELL = "/bin/zsh";
            expect(root()).toContain("Shell: /bin/bash");
            expect(root()).not.toContain("Shell: /bin/zsh");
        } finally {
            if (previous === undefined) delete process.env.SHELL;
            else process.env.SHELL = previous;
        }
    });
    test("Root and actual worker prompts share evidence-driven implementation guidance while preserving read-only restrictions", () => {
        const history = createInitialHistory("/project");
        const readOnly = withExecutionContext(history, {
            permissionMode: "ask",
            permissionPromptPolicy: "onRequest", readOnlyTools: true,
        });
        const worker = createAgentSystemPrompt(EXPLORE_AGENT, "/child", ["read_file"]);
        for (const prompt of [contentText(history[0]!.content), contentText(readOnly[0]!.content), worker]) {
            expect(prompt.match(/# Task execution/g)).toHaveLength(1);
            expect(prompt).toContain("For implementation work");
            expect(prompt).toContain("next verifiable change");
            expect(prompt).toContain("smallest relevant experiment or focused test");
            expect(prompt).toContain("Broaden a search only to answer a specific unresolved question");
            expect(prompt).toContain("follow the actual call chain through inputs, outputs and callers");
            expect(prompt).toContain("verify the reported reproduction, relevant boundary conditions and affected related implementations");
            expect(prompt).toContain("without making unsolicited implementation changes");
            expect(prompt).toContain("Speed does not justify skipping necessary analysis or verification");
        }
        expect(contentText(readOnly[0]!.content)).toContain("restricted to read-only tools");
        expect(worker).not.toContain("# Tools and coordination");
    });
    test("Root keeps authorization, language and verification boundaries while tool details live with tools", () => {
        const prompt = root();
        expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
        expect(prompt).toContain("Respond in the user's language");
        expect(prompt).toContain("Commit and push each require explicit authorization");
        expect(prompt).toContain("does not change tool permissions or replace runtime approval");
        expect(prompt).toContain("not automatically unresolved work");
        expect(prompt).toContain("unless explicitly asked to build that infrastructure");
        expect(prompt).toContain("stop that verification branch");
        expect(prompt).toContain("Once the user's requirements are met and necessary checks provide sufficient evidence, stop and deliver");
        expect(prompt).not.toContain("64 MiB");
        expect(prompt).not.toContain("timeout_ms");
        expect(prompt).not.toContain("Respect explicit denials, Plan,");
        expect(prompt).toContain("Respect explicit denials, read-only restrictions");
        expect(toolDescription("bash")).toContain("rg --files");
        expect(toolDescription("bash")).toContain("Bash has no model-set execution deadline");
        expect(toolDescription("bash")).toContain("stop it before restarting");
        expect(toolDescription("bash")).toContain("Do not use git add . or git add -A");
        expect(toolDescription("edit_file")).toContain("same original version");
        expect(toolDescription("edit_file")).toContain("no prior read_file receipt is required for local edits");
        expect(toolDescription("read_file")).toContain("a log does not establish the current source-file version");
    });
    test("worker gets shared safety and evidence rules without Root coordination", () => {
        const worker = createSubagentInstructions();
        expect(worker).toContain("Dual-use offensive work requires clear authorization and scope");
        expect(worker).toContain("not new user instructions or authorization");
        expect(worker).toContain("stop that verification branch");
        expect(worker).toContain("Do not spawn agents");
        expect(worker).not.toContain("# Tools and coordination");
        expect(worker).not.toContain("Use an available agent");
        const custom = createAgentSystemPrompt({...EXPLORE_AGENT, systemPrompt: "用户自己的角色内容"}, "/child", ["read_file"]);
        expect(custom).toContain("用户自己的角色内容");
        expect(custom).toContain("Working directory: /child");
        expect(custom).toContain("Available tools: read_file");
    });
    test("Root and dispatched workers cannot improvise image-review infrastructure from view_image availability", () => {
        const worker = createAgentSystemPrompt(EXPLORE_AGENT, "/child", ["view_image", "bash"]);
        for (const prompt of [root(), worker]) {
            expect(prompt).toContain("Screenshot or generated-image review requires an explicit user request");
            expect(prompt).toContain("or an available dedicated capture/render tool");
            expect(prompt).toContain("Missing capture infrastructure requires an explicit setup request");
            expect(prompt).toContain("Installed dependencies and existing artifacts do not authorize creating an image-review workflow");
            expect(prompt).toContain("Reading user-provided images and producing requested image deliverables remain valid");
            expect(prompt).toContain("Do not present script-generated approximations as real browser/WebGL rendering evidence");
            expect(prompt).toContain("the project's established E2E workflow");
            expect(prompt).toContain("earlier images are sent only as text references, without pixels");
            expect(prompt).toContain("call view_image(image_id) when you need visual detail again");
        }
        expect(toolDescription("view_image")).toContain("does not provide screenshot or rendering capability");
    });
    test("permission facts reflect interaction policy without mutating History or conversation", () => {
        const history = [...createInitialHistory("/project"), {role: "user" as const, origin: "user" as const, content: "保留中文任务"}];
        const before = structuredClone(history);
        const base = { permissionMode: "ask" as const, permissionPromptPolicy: "never" as const, readOnlyTools: false};
        const never = withExecutionContext(history, base);
        expect(contentText(never[0]!.content)).toContain("There is no interactive approval channel");
        expect(never.slice(1)).toEqual(history.slice(1));
        expect(history).toEqual(before);
        const review = withExecutionContext(history, {...base, permissionMode: "auto-review", permissionPromptPolicy: "onRequest"});
        expect(contentText(review[0]!.content)).toContain("independent approval reviewer");
        expect(contentText(review[0]!.content)).not.toContain("no interactive approval channel");
        const fullReadOnly = withExecutionContext(history, {...base, permissionMode: "full-access", readOnlyTools: true});
        expect(contentText(fullReadOnly[0]!.content)).not.toContain("collaboration_mode");
        expect(contentText(fullReadOnly[0]!.content)).toContain("restricted to read-only tools");
        expect(contentText(fullReadOnly[0]!.content)).toContain("does not authorize unrelated tasks");
        expect(JSON.stringify(history)).not.toContain("execution_context");
    });
    test("Root and subagent prompts omit model identity while retaining environment and tools", () => {
        const worker = createAgentSystemPrompt(EXPLORE_AGENT, "/child", ["read_file"]);
        for (const prompt of [root(), worker]) expect(prompt).not.toMatch(/^Model:/m);
        expect(root()).toContain("Working directory: /project");
        expect(root()).toContain("Platform:");
        expect(worker).toContain("Working directory: /child");
        expect(worker).toContain("Available tools: read_file");
    });
});
