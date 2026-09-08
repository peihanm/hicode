/** Opt-in V0 dependency probe. Installs only into an owned temporary directory. */
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "--install" || args.length > 2) {
    throw new Error("用法: bun tests/diagnostics/imagePackage.ts --install [image-path]；下载隔离依赖，不调用模型");
}
const screenshot = args[1] ? resolve(args[1]) : undefined;
const root = await mkdtemp(resolve(tmpdir(), "pillar-image-v0-"));
const staging = resolve(root, "staging");
const consumer = resolve(root, "consumer");
const cache = resolve(root, "cache");
const version = "0.35.4";
const env = {...process.env, TMPDIR: root, BUN_INSTALL_CACHE_DIR: cache};

async function run(command: string[], cwd: string): Promise<string> {
    const child = Bun.spawn(command, {cwd, env, stdout: "pipe", stderr: "pipe"});
    const timer = setTimeout(() => child.kill(), 120_000);
    try {
        const [status, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (status !== 0) throw new Error(`${command.join(" ")} (${status})\n${stdout}\n${stderr}`);
        return stdout.trim();
    } finally {
        clearTimeout(timer);
    }
}

try {
    for (const directory of [staging, consumer, cache]) await mkdir(directory);
    await writeFile(resolve(staging, "package.json"), JSON.stringify({
        name: "pillar-image-v0-probe", version: "0.0.0", private: true, type: "module",
        exports: "./index.js", files: ["index.js"], dependencies: {sharp: version},
    }));
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dirname, "../fixtures/imagePackageProbe.mjs")],
        outdir: staging, naming: "index.js", target: "node", format: "esm", packages: "external",
    });
    assert.ok(build.success, build.logs.map(String).join("\n"));
    assert.match(await readFile(resolve(staging, "index.js"), "utf8"), /from ["']sharp["']/);
    console.log(`Installing isolated sharp@${version} (scripts disabled)`);
    await run([process.execPath, "install", "--ignore-scripts", "--no-progress"], staging);
    await run([process.execPath, "pm", "pack", "--destination", root, "--ignore-scripts", "--quiet"], staging);
    const tarballs = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    await writeFile(resolve(consumer, "package.json"), JSON.stringify({
        private: true, type: "module", dependencies: {"pillar-image-v0-probe": `file:${resolve(root, tarballs[0]!)}`},
    }));
    // Remove staging to rule out imports resolving through the source package.
    await rm(staging, {recursive: true});
    await run([process.execPath, "install", "--offline", "--ignore-scripts", "--no-progress"], consumer);
    await writeFile(resolve(consumer, "consumer.mjs"), [
        'import {runImageProbe} from "pillar-image-v0-probe";',
        'console.log(JSON.stringify(await runImageProbe(process.argv[2])));',
    ].join("\n"));
    for (const runtime of ["node", process.execPath]) {
        const output = await run([runtime, "consumer.mjs", ...(screenshot ? [screenshot] : [])], consumer);
        const result: unknown = JSON.parse(output);
        assert.ok(result && typeof result === "object" && "passed" in result && result.passed === (screenshot ? 10 : 9));
        console.log(output);
    }
    console.log("IMAGE_PACKAGE_V0_OK: cached offline install, external native dependency, Node + Bun");
} finally {
    await rm(root, {recursive: true, force: true});
}
