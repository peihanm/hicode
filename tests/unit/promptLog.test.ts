import {describe, expect, test} from "bun:test";
import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {beginPromptLog} from "../../src/llm/promptLog.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("prompt log lifecycle", () => {
    test("请求开始写入 pending，结束后原位写入最终结果", async () => {
        await withTempProject(async (cwd) => {
            const handle = beginPromptLog(
                cwd,
                1,
                "main",
                "glm-5.2",
                {messages: [{role: "user", content: "private prompt"}]}
            );
            const directory = join(cwd, ".pillar", "prompt-log");
            const [filename] = await readdir(directory);
            const pending = JSON.parse(
                await readFile(join(directory, filename!), "utf8")
            ) as {response: unknown};
            expect(pending.response).toEqual({status: "pending"});

            handle.finish({error: "stalled"});
            const finished = JSON.parse(
                await readFile(join(directory, filename!), "utf8")
            ) as {response: unknown};
            expect(finished.response).toEqual({error: "stalled"});
        });
    });
});
