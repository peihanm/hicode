import {expect, test} from "bun:test";
import {ApprovalEpoch} from "../../src/permissions/approval.js";
import {SessionPermissionPolicy} from "../../src/permissions/sessionPolicy.js";
import type {PermissionRules} from "../../src/permissions/types.js";

test("saving an additional allow preserves the current dialog; restrictions invalidate pending decisions", () => {
    const rules: PermissionRules = {allow: [], ask: [], deny: []};
    const epoch = new ApprovalEpoch();
    const policy = new SessionPermissionPolicy("ask", rules, epoch, true);
    const pending = epoch.signal;
    const allowed: PermissionRules = {...rules, allow: [{toolName: "bash", content: "pwd", source: "user"}]};
    policy.setRules(allowed);
    expect(pending.aborted).toBe(false);
    expect(policy.getRules()).toEqual(allowed);
    policy.setRules({...allowed, deny: [{toolName: "write_file", source: "user"}]});
    expect(pending.aborted).toBe(true);
    const removal = epoch.signal;
    policy.setRules(rules);
    expect(removal.aborted).toBe(true);
    const mode = epoch.signal;
    policy.setMode("auto-review");
    expect(mode.aborted).toBe(true);
    expect(policy.getMode()).toBe("auto-review");
});
