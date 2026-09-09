import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {contentText} from "../../src/images/content.js";

await withTempProject(async cwd => {
    await writeFile(join(cwd, "danger.txt"), ("a".repeat(32) + "!\n").repeat(100));
    if (process.argv[2] === "deadline") {
        const result = await executeToolResult("grep", '{"path":"danger.txt","pattern":"(a+)+$"}', createTestContext(cwd), "deadline");
        if (result.outcome !== "failed" || contentText(result.modelContent).includes("未找到匹配")) throw new Error(JSON.stringify(result));
        process.stdout.write("GREP_FAILED_WITHOUT_FALSE_NEGATIVE");
        return;
    }
    const controller = new AbortController();
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const abort = setTimeout(() => controller.abort("user-cancel"), 150);
    try {
        const results = await Promise.all([false, true].map(multiline => executeToolResult("grep",
            JSON.stringify({path: "danger.txt", pattern: "(a+)+$", multiline}),
            createTestContext(cwd, {signal: controller.signal}), `cancel-${multiline}`)));
        if (ticks < 2 || results.some(result => result.outcome !== "interrupted")) throw new Error(JSON.stringify({ticks, results}));
    } finally { clearTimeout(abort); clearInterval(heartbeat); }
    const next = await executeToolResult("grep", '{"path":"danger.txt","pattern":"!","head_limit":1}', createTestContext(cwd), "next");
    if (next.outcome !== "ok") throw new Error("A cancelled search affected the next invocation");
    process.stdout.write("GREP_CANCELLED_AND_RECOVERED");
});
