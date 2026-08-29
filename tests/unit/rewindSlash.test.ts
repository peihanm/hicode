import {describe, expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/rewind slash command", () => {
    test("rewind 与 checkpoint alias 只调用 Host capability", async () => {
        await withTempProject(async (cwd) => {
            let opened = 0;
            const context = {
                history: [],
                ctx: createTestContext(cwd),
                onEvent: () => {},
                openRewind: () => {
                    opened += 1;
                },
            };
            expect(await processSlashCommand("/rewind", context)).toBe(true);
            expect(await processSlashCommand("/checkpoint", context)).toBe(true);
            expect(opened).toBe(2);
        });
    });

    test("没有交互 Host 时返回明确说明", async () => {
        await withTempProject(async (cwd) => {
            const messages: string[] = [];
            expect(await processSlashCommand("/rewind", {
                history: [],
                ctx: createTestContext(cwd),
                onEvent(event) {
                    if (event.type === "assistant_text") messages.push(event.content);
                },
            })).toBe(true);
            expect(messages).toEqual(["当前宿主不支持交互式 /rewind。"]);
        });
    });
});
