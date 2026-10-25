import {expect, test} from "bun:test";
import {getSlashCommands, getSlashCommandSuggestions} from "../../src/slash/registry.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {withExecutionContext} from "../../src/prompt/messages.js";
import {contentText} from "../../src/images/content.js";

test("planning uses user intent without mode commands or injected mode state", () => {
    expect(getSlashCommands().map(command => command.name)).not.toContain("plan");
    expect(getSlashCommands().map(command => command.name)).not.toContain("build");
    expect(getSlashCommandSuggestions("/plan")).toEqual([]);
    expect(getSlashCommandSuggestions("/build")).toEqual([]);
    const history = createInitialHistory("/project");
    const before = structuredClone(history);
    const messages = withExecutionContext(history, {permissionMode: "full-access", permissionPromptPolicy: "never", readOnlyTools: true});
    const system = contentText(messages[0]!.content);
    expect(system).not.toContain("collaboration_mode");
    expect(system).toContain("planning requests");
    expect(system).toContain("without making unsolicited implementation changes");
    expect(system).toContain("restricted to read-only tools");
    expect(system).toContain("does not authorize unrelated tasks");
    expect(history).toEqual(before);
});
