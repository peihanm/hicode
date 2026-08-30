import type {SubagentRegistration} from "../../registration.js";
import {VERIFICATION_AGENT} from "./definition.js";
import {parseVerificationSummary, parseVerificationVerdict,} from "./report.js";
import {createVerificationRuntimeConfig} from "./runtime.js";

export const VERIFICATION_SUBAGENT: SubagentRegistration = {
    definition: VERIFICATION_AGENT,
    concurrencySafe: false,
    createRuntimeConfig: createVerificationRuntimeConfig,
    finalizePrompt: [
        "验证工具阶段已经结束。",
        "现在禁止继续调用工具，请仅根据已经获得的真实执行证据给出验证报告。",
        "必须明确已验证、失败和受环境限制的部分；没有证据的项目不能标为通过。",
        "在最终 VERDICT 前输出一行 SUMMARY: <用户无需展开报告即可理解的一句话结论>。",
        "最后一行必须严格为 VERDICT: PASS、VERDICT: FAIL 或 VERDICT: PARTIAL。",
    ].join("\n"),
    parseResult(reply) {
        return {
            verificationVerdict:
                parseVerificationVerdict(reply) ?? "PARTIAL",
        };
    },
};

export {
    parseVerificationSummary,
};
