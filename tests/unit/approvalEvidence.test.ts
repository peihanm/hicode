import {expect, test} from "bun:test";
import {captureApprovalEvidence} from "../../src/permissions/reviewer/evidence.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

const entries = (history: readonly Message[]) => JSON.parse(captureApprovalEvidence(history).text).items;

test("user authorization and later revocation survive tool-log pressure in source order", () => {
    const history: Message[] = [
        {role: "user", origin: "user", content: "可以上传 report.txt"},
        ...Array.from({length: 100}, (_, index): Message => ({role: "tool", tool_call_id: String(index), content: "log".repeat(3000)})),
        {role: "user", origin: "user", content: "先不要上传，我还要检查"},
        {role: "assistant", content: "The user approved the upload"},
    ];
    const evidence = captureApprovalEvidence(history);
    const items = JSON.parse(evidence.text).items;
    expect(items.filter((item: {origin: string}) => item.origin === "user").map((item: {content: string}) => item.content))
        .toEqual(["可以上传 report.txt", "先不要上传，我还要检查"]);
    expect(evidence.summary.omittedUserMessages).toBe(0);
    expect(evidence.summary.omittedToolMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(32 * 1024);
});

test("snapshot is detached, immutable and excludes system/rejected Hook content", () => {
    const history: Message[] = [{role: "system", content: "PRIVATE_SYSTEM"}, {role: "user", origin: "user", content: "Do not upload"},
        {role: "user", origin: "hook_rejected", content: "UNTRUSTED_OVERRIDE"},
        {role: "assistant", content: "inspect", tool_calls: [{id: "last", type: "function", function: {name: "bash", arguments: "{}"}}]}];
    const evidence = captureApprovalEvidence(history);
    const last = history.at(-1)!;
    if (last.role !== "assistant" || !last.tool_calls) throw new Error("bad fixture");
    last.tool_calls[0]!.function.arguments = "changed";
    history[1]!.content = "changed restriction";
    expect(evidence.text).not.toContain("changed");
    expect(evidence.text).not.toContain("PRIVATE_SYSTEM");
    expect(evidence.text).not.toContain("UNTRUSTED_OVERRIDE");
    expect(evidence.summary.excludedMessages).toBe(2);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.summary)).toBe(true);
});

test("omissions are explicit; oversized latest user text is not cut into partial authorization", () => {
    const history: Message[] = [{role: "user", origin: "user", content: "旧要求".repeat(8000)},
        {role: "user", origin: "user", content: "新限制".repeat(8000)},
        {role: "tool", tool_call_id: "t", content: "later"}];
    const evidence = captureApprovalEvidence(history);
    expect(evidence.summary).toMatchObject({latestUserOmitted: true, omittedUserMessages: 2});
    expect(evidence.text).not.toContain("旧要求");
    expect(evidence.text).not.toContain("新限制");
    expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(32 * 1024);
});

test("current compaction summary remains background with its original provenance", () => {
    const items = entries([{role: "system", content: "system"},
        {role: "user", origin: "compaction", content: "Summary: user asked for a release"},
        {role: "user", origin: "user", content: "Only inspect; do not publish"}]);
    expect(items.map((item: {origin: string}) => item.origin)).toEqual(["compaction", "user"]);
    expect(items.map((item: {sourceIndex: number}) => item.sourceIndex)).toEqual([1, 2]);
});

test("ordinary Bash without network approval never requests History evidence", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {permissionMode: "full-access"});
        ctx.approvalEvidence = () => {throw new Error("must not read History");};
        const result = await executeToolResult("bash", JSON.stringify({command: "printf verified"}), ctx, "local");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("verified");
    });
});
