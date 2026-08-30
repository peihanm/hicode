import {describe, expect, test} from "bun:test";
import {Buffer} from "node:buffer";
import {join} from "node:path";
import type {MemoryExtractor} from "../../src/memory/index.js";
import {serializeMemoryFile} from "../../src/memory/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

describe("MemoryRuntime", () => {
    test("关闭时会提取尚未达到批次阈值的短会话", async () => {
        await withTempProject(async (cwd) => {
            let received: Parameters<MemoryExtractor["extract"]>[0] | undefined;
            const memory = createTestMemoryRuntime(cwd, {
                directory: join(cwd, "memory"),
                autoExtract: true,
                createExtractor: () => ({
                    async extract(input) {
                        received = input;
                    },
                }),
            });

            memory.considerCompletedTurn({
                userInput: "帮我解释一下这个模块",
                assistantText: "这里是模块说明。",
                onEvent: () => {},
            });
            expect(received).toBeUndefined();

            await memory.close();

            expect(received?.turns).toEqual([{
                user: "帮我解释一下这个模块",
                assistant: "这里是模块说明。",
            }]);
        });
    });

    test("关闭时会在当前提取后继续 drain trailing batch", async () => {
        await withTempProject(async (cwd) => {
            const received: Array<readonly {user: string; assistant: string}[]> = [];
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            let firstStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                firstStarted = resolve;
            });
            const memory = createTestMemoryRuntime(cwd, {
                directory: join(cwd, "memory"),
                autoExtract: true,
                createExtractor: () => ({
                    async extract(input) {
                        received.push(input.turns);
                        if (received.length === 1) {
                            firstStarted();
                            await firstGate;
                        }
                    },
                }),
            });

            memory.considerCompletedTurn({
                userInput: "请记住第一个长期偏好",
                assistantText: "已记录。",
                onEvent: () => {},
            });
            await started;
            memory.considerCompletedTurn({
                userInput: "这是关闭前的普通短对话",
                assistantText: "收到。",
                onEvent: () => {},
            });

            const closing = memory.close();
            releaseFirst();
            await closing;

            expect(received).toHaveLength(2);
            expect(received[1]?.[0]?.user).toBe("这是关闭前的普通短对话");
        });
    });

    test("大型 UTF-8 Turn 保留有界候选，自动变化不冒充显式变化", async () => {
        await withTempProject(async (cwd) => {
            let received: Parameters<MemoryExtractor["extract"]>[0] | undefined;
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
