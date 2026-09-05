import {describe, expect, test} from "bun:test";
import {normalizeInteractionResponse} from "../../src/sdk/interaction.js";

describe("SDK network response validation", () => {
    test("答案使用独立字段，拒绝无效答案和问题参数替换", () => {
        expect(normalizeInteractionResponse({behavior: "allow", answers: {"问题": "回答"}}))
            .toEqual({behavior: "allow", answers: {"问题": "回答"}});
        for (const answers of [null, [], {}, {"问题": 42}, {"问题": " "}, {"问题": "a".repeat(16_385)}]) {
            expect(normalizeInteractionResponse({behavior: "allow", answers}).behavior).toBe("deny");
        }
        expect(normalizeInteractionResponse({behavior: "allow", updatedInput: {questions: []}}).behavior).toBe("deny");
        expect(normalizeInteractionResponse({behavior: "allow", networkScope: "once", answers: {"问题": "回答"}}).behavior).toBe("deny");
    });
    test("允许单连接和会话 scope，不静默扩展范围", () => {
        for (const networkScope of ["once", "session"] as const) {
            const response = {behavior: "allow", networkScope} as const;
            expect(normalizeInteractionResponse(response)).toEqual(response);
        }
        expect(normalizeInteractionResponse({behavior: "allow"})).toEqual({behavior: "allow"});
    });
    test("拒绝无效 scope 及混用持久化/目录授权", () => {
        for (const extra of [
            {networkScope: "project"}, {networkScope: true}, {networkScope: null},
            {networkScope: "session", directoryScope: "once"},
            {networkScope: "session", persistence: "always"},
        ]) {
            expect(normalizeInteractionResponse({behavior: "allow", ...extra}).behavior).toBe("deny");
        }
    });
});
