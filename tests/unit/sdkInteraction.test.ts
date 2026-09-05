import {describe, expect, test} from "bun:test";
import {normalizeInteractionResponse} from "../../src/sdk/interaction.js";

describe("SDK network response validation", () => {
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
