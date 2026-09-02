import {spawn} from "node:child_process";
import {createServer} from "node:net";

const MAX_LOG_BYTES = 64 * 1024;

async function main(): Promise<void> {
    const port = await reservePort();
    const child = spawn("bun", ["run", "start"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(port),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = collectBoundedOutput(child.stdout);
    const stderr = collectBoundedOutput(child.stderr);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitUntilReady(baseUrl, child);
        await verifyPage(baseUrl);
        await verifyCorrectSolution(baseUrl);
        await verifyWrongSolution(baseUrl);
        await verifySyntaxError(baseUrl);
        await verifyTimeoutIsolation(baseUrl);
        const stillAlive = await fetchText(`${baseUrl}/`, 2_000);
        require(stillAlive.response.ok, "超时用例后 Web 服务不再可用");
        process.stdout.write("HIDDEN_LEETCODE_WEB_OK\n");
    } catch (error) {
        const logs = [
            formatLog("server stdout", stdout()),
            formatLog("server stderr", stderr()),
        ].filter(Boolean).join("\n");
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}` +
            `${logs ? `\n${logs}` : ""}`
        );
    } finally {
        await stopProcessTree(child.pid, child.exitCode);
    }
}

async function verifyPage(baseUrl: string): Promise<void> {
    const page = await fetchText(`${baseUrl}/`, 2_000);
    require(page.response.status === 200, "GET / 必须返回 200");
    require(
        page.response.headers.get("content-type")?.includes("text/html") === true,
        "GET / 必须返回 HTML"
    );
    require(/two\s*sum|两数之和/i.test(page.text), "页面缺少 Two Sum 题目");
    require(/<textarea\b/i.test(page.text), "页面缺少代码 textarea");
    require(/<button\b/i.test(page.text), "页面缺少运行按钮");
    require(/app\.js/i.test(page.text), "页面没有加载 public/app.js");
    require(/styles\.css/i.test(page.text), "页面没有加载 public/styles.css");

    const [script, styles] = await Promise.all([
        fetchText(`${baseUrl}/app.js`, 2_000),
        fetchText(`${baseUrl}/styles.css`, 2_000),
    ]);
    require(script.response.status === 200, "GET /app.js 必须返回 200");
    require(styles.response.status === 200, "GET /styles.css 必须返回 200");
    require(/\/api\/run/.test(script.text), "浏览器代码没有调用 /api/run");
    const githubColors = [
        "#ffffff",
        "#fff",
        "#f6f8fa",
        "#24292f",
        "#1f2328",
        "#d0d7de",
        "#0969da",
        "#2da44e",
    ].filter((color) => styles.text.toLowerCase().includes(color));
    require(githubColors.length >= 3, "CSS 缺少可识别的 GitHub 白色配色基础");
}

async function verifyCorrectSolution(baseUrl: string): Promise<void> {
    const result = await runCode(baseUrl, [
        "function twoSum(nums, target) {",
        "  const seen = new Map();",
        "  for (let index = 0; index < nums.length; index += 1) {",
        "    const needed = target - nums[index];",
        "    if (seen.has(needed)) return [seen.get(needed), index];",
        "    seen.set(nums[index], index);",
        "  }",
        "  return [];",
        "}",
    ].join("\n"), 5_000);
    require(result.ok === true, "正确解法必须返回 ok=true");
    const total = requireNumber(result.total, "正确解法 total");
    const passed = requireNumber(result.passed, "正确解法 passed");
    require(total >= 4, "后端必须执行至少 4 组测试");
    require(passed === total, "正确解法没有通过全部测试");
    const results = requireArray(result.results, "正确解法 results");
    require(results.length === total, "results 数量必须等于 total");
    require(
        results.every((item) => isRecord(item) && item.passed === true),
        "正确解法 results 必须逐项通过"
    );
}

async function verifyWrongSolution(baseUrl: string): Promise<void> {
    const result = await runCode(
        baseUrl,
        "function twoSum() { return [0, 0]; }",
        5_000
    );
    const total = requireNumber(result.total, "错误解法 total");
    const passed = requireNumber(result.passed, "错误解法 passed");
    const results = requireArray(result.results, "错误解法 results");
    require(passed < total, "错误解法不能被报告为全部通过");
    require(
        results.some((item) => isRecord(item) && item.passed === false),
        "错误解法必须包含失败的逐项测试"
    );
}

async function verifySyntaxError(baseUrl: string): Promise<void> {
    const result = await runCode(
        baseUrl,
        "function twoSum( {",
        5_000
    );
    require(result.ok === false, "语法错误必须返回 ok=false");
    require(
        typeof result.error === "string" && result.error.length > 0,
        "语法错误必须返回可读 error"
    );
}

async function verifyTimeoutIsolation(baseUrl: string): Promise<void> {
    const started = performance.now();
    const result = await runCode(
        baseUrl,
        "function twoSum() { while (true) {} }",
        6_000
    );
    const elapsed = performance.now() - started;
    require(elapsed < 5_000, "死循环没有在有界时间内终止");
    require(result.ok === false, "死循环必须返回 ok=false");
    const resultErrors = requireArray(result.results, "死循环 results")
        .flatMap((item) => isRecord(item) && typeof item.error === "string"
            ? [item.error]
            : []);
    const timeoutErrors = [
        ...(typeof result.error === "string" ? [result.error] : []),
        ...resultErrors,
    ];
    require(
        timeoutErrors.some((message) =>
            /timeout|timed out|time limit|超时|终止/i.test(message)
        ),
        "死循环必须返回明确的超时错误"
    );
}

async function runCode(
    baseUrl: string,
    code: string,
    timeoutMs: number
): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/api/run`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({code}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    require(
        response.headers.get("content-type")?.includes("application/json") === true,
        "POST /api/run 必须返回 JSON"
    );
    const parsed = await response.json() as unknown;
    require(isRecord(parsed), "POST /api/run 响应必须是 object");
    return parsed;
}

async function waitUntilReady(
    baseUrl: string,
    child: {exitCode: number | null}
): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Web 服务提前退出：exit ${child.exitCode}`);
        }
        try {
            const response = await fetch(`${baseUrl}/`, {
                signal: AbortSignal.timeout(500),
            });
            if (response.status === 200) return;
        } catch {
            // Server may still be starting.
        }
        await delay(100);
    }
    throw new Error("Web 服务未在 8 秒内启动");
}

async function fetchText(
    url: string,
    timeoutMs: number
): Promise<{response: Response; text: string}> {
    const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    return {response, text: await response.text()};
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("无法分配验证端口");
    }
    await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
    );
    return address.port;
}

function collectBoundedOutput(
    stream: NodeJS.ReadableStream
): () => string {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        output = `${output}${chunk}`.slice(-MAX_LOG_BYTES);
    });
    return () => output.trim();
}

async function stopProcessTree(
    pid: number | undefined,
    exitCode: number | null
): Promise<void> {
    if (!pid || exitCode !== null) return;
    signalProcessTree(pid, "SIGTERM");
    await delay(300);
    signalProcessTree(pid, "SIGKILL");
}

function signalProcessTree(
    pid: number,
    signal: NodeJS.Signals
): void {
    try {
        process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch (error) {
        if (!isRecord(error) || error.code !== "ESRCH") throw error;
    }
}

function requireNumber(value: unknown, label: string): number {
    require(
        typeof value === "number" && Number.isInteger(value) && value >= 0,
        `${label} 必须是非负整数`
    );
    return value;
}

function requireArray(value: unknown, label: string): unknown[] {
    require(Array.isArray(value), `${label} 必须是 array`);
    return value;
}

function require(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function formatLog(label: string, output: string): string {
    return output ? `${label}:\n${output}` : "";
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
    process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
});
