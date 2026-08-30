import {randomUUID} from "node:crypto";
import {readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = join(import.meta.dir, "public");
const contentTypes: Record<string, string> = {
    "/": "text/html; charset=utf-8",
    "/app.js": "text/javascript; charset=utf-8",
    "/styles.css": "text/css; charset=utf-8",
};

Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/run" && request.method === "POST") {
            return runSolution(request);
        }
        const relative = url.pathname === "/" ? "index.html" :
            url.pathname === "/app.js" ? "app.js" :
                url.pathname === "/styles.css" ? "styles.css" : undefined;
        if (!relative) return new Response("Not found", {status: 404});
        return new Response(await readFile(join(publicDirectory, relative)), {
            headers: {"content-type": contentTypes[url.pathname] ?? "text/plain"},
        });
    },
});

async function runSolution(request: Request): Promise<Response> {
    const input = await request.json() as unknown;
    if (!isRecord(input) || typeof input.code !== "string") {
        return Response.json({ok: false, error: "code is required"}, {status: 400});
    }
    const path = join(tmpdir(), `pillar-eval-solution-${randomUUID()}.js`);
    await writeFile(path, buildRunner(input.code));
    const child = Bun.spawn(["bun", path], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, 1_000);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if (timedOut) {
            return Response.json({
                ok: false,
                passed: 0,
                total: 1,
                results: [{passed: false, error: "Execution timeout"}],
            });
        }
        if (exitCode !== 0) {
            return Response.json({
                ok: false,
                error: stderr.trim() || `Runner exited ${exitCode}`,
            });
        }
        try {
            return Response.json(JSON.parse(stdout) as unknown);
        } catch {
            return Response.json({ok: false, error: "Invalid runner output"});
        }
    } finally {
        clearTimeout(timeout);
        await rm(path, {force: true});
    }
}

function buildRunner(code: string): string {
    return `${code}\n${String.raw`
const cases = [
  {name: "basic", nums: [2, 7, 11, 15], target: 9, expected: [0, 1]},
  {name: "middle", nums: [3, 2, 4], target: 6, expected: [1, 2]},
  {name: "same values", nums: [3, 3], target: 6, expected: [0, 1]},
  {name: "negative", nums: [-3, 4, 3, 90], target: 0, expected: [0, 2]},
];
const normalize = (value) => Array.isArray(value) ? [...value].sort((a, b) => a - b) : value;
const results = cases.map((item) => {
  try {
    const actual = twoSum([...item.nums], item.target);
    const passed = JSON.stringify(normalize(actual)) === JSON.stringify(normalize(item.expected));
    return {name: item.name, passed, actual};
  } catch (error) {
    return {name: item.name, passed: false, error: error instanceof Error ? error.message : String(error)};
  }
});
const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ok: true, passed, total: results.length, results}));
`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
