import {expect, test} from "bun:test";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

test("API audit separates production, aliases, tooling, local implementations and the public SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "hicode-api-audit-"));
    try {
        for (const dir of ["src/sdk", "tests", "tooling"]) await mkdir(join(root, dir), {recursive: true});
        const files: Record<string, string> = {
            "src/index.tsx": 'import "./lib.js"; void import("./dynamic.js");',
            "src/lib.ts": 'export function testOnly() {} export function local() {} local(); export function diagnostic() {} export function unused() {}',
            "src/barrel.ts": 'export {testOnly as forwarded} from "./lib.js";',
            "src/dynamic.ts": 'import {dynamicHelper} from "./helper.js"; dynamicHelper();',
            "src/helper.ts": 'export function dynamicHelper() {}',
            "src/sdk/index.ts": 'export class PublicAPI { exposed() {return 1;} }',
            "tests/use.ts": 'import {forwarded} from "../src/barrel.js"; import {local} from "../src/lib.js"; import {PublicAPI} from "../src/sdk/index.js"; forwarded(); local(); new PublicAPI().exposed();',
            "tooling/use.ts": 'import {diagnostic} from "../src/lib.js"; diagnostic();',
            "tsconfig.test.json": JSON.stringify({compilerOptions: {target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext"}, include: ["src", "tests", "tooling"]}),
            "tsconfig.tooling.json": JSON.stringify({extends: "./tsconfig.test.json"}),
        };
        for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
        const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/audit-test-only-api.ts"), "--json"], {cwd: root, stdout: "pipe", stderr: "pipe"});
        const deadline = setTimeout(() => child.kill(), 20_000);
        const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(deadline));
        expect({code, error}).toEqual({code: 0, error: ""});
        const report = JSON.parse(output) as {findings: {symbol: string; kind: string}[]; publicApi: {symbol: string}[]};
        const found = new Map(report.findings.map(item => [item.symbol, item.kind]));
        expect(found.get("testOnly")).toBe("TEST_ONLY_EXPORT");
        expect(found.get("local")).toBe("LOCAL_ONLY_EXPORT");
        expect(found.get("diagnostic")).toBe("TOOLING_ONLY_EXPORT");
        expect(found.get("unused")).toBe("UNUSED_EXPORT");
        expect(found.has("dynamicHelper")).toBe(false);
        expect(found.has("PublicAPI.exposed")).toBe(false);
        expect(report.publicApi.some(item => item.symbol === "exposed")).toBe(true);
    } finally {await rm(root, {recursive: true, force: true});}
}, 30_000);
