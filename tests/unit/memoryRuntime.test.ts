import {describe, expect, test} from "bun:test";
import {Buffer} from "node:buffer";
import {join} from "node:path";
import type {
    MemoryExtractionInput,
} from "../../src/memory/index.js";
import {serializeMemoryFile} from "../../src/memory/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

describe("MemoryRuntime", () => {
    test("大型 UTF-8 Turn 保留有界候选，自动变化不冒充显式变化", async () => {
        await withTempProject(async (cwd) => {
            let received: MemoryExtractionInput | undefined;
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {
                directory,
                autoExtract: true,
                createExtractor: ({memoryFiles}) => ({
                    async extract(input) {
                        received = input;
                        const timestamp = "2026-07-26T00:00:00.000Z";
                        const content = serializeMemoryFile(
                            {
                                key: "user-large-input",
                                name: "大型输入偏好",
                                description: "大型输入中的长期偏好",
                                type: "user",
                                source: "automatic",
                                content: "保留大型 UTF-8 输入中的有效候选。",
                            },
                            {createdAt: timestamp, updatedAt: timestamp}
                        );
                        await memoryFiles.write(
                            join(directory, "user-large-input.md"),
                            content,
                            null
                        );
                    },
                }),
            });
            const revision = memory.getRevision();

            memory.considerCompletedTurn({
                userInput: `请记住这个偏好：${"界".repeat(20_000)}`,
                assistantText: "明白。",
                onEvent: () => {},
            });
            await memory.close();

            const user = received?.turns[0]?.user ?? "";
            expect(user.startsWith("请记住这个偏好")).toBe(true);
            expect(Buffer.byteLength(user, "utf8")).toBeLessThanOrEqual(16 * 1024);
            expect(memory.explicitChangesSince(revision)).toEqual([]);
            expect((await memory.read("user-large-input"))?.source).toBe("automatic");
        });
    });
});
