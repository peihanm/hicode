import {access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, resolve} from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const packageDirectory = resolve(repositoryRoot, "dist", "sdk-package");

async function run(
    command: string[],
    cwd: string
): Promise<string> {
    const child = Bun.spawn(command, {
        cwd,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; child.kill("SIGKILL");}, 120_000);
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error(`验证命令超过 120 秒：${command[0]}`);
    if (exitCode !== 0) {
        throw new Error([
            `命令失败 (${exitCode}): ${command.join(" ")}`,
            stdout.trim(),
            stderr.trim(),
        ].filter(Boolean).join("\n"));
    }
    return stdout.trim();
}

async function main(): Promise<void> {
    const temporaryRoot = await mkdtemp(
        resolve(tmpdir(), "pillar-sdk-package-")
    );
    try {
        await run(
            [
                process.execPath,
                resolve(repositoryRoot, "tooling", "scripts", "build-sdk-package.ts"),
            ],
            repositoryRoot
        );
        const packageManifest = JSON.parse(await readFile(
            resolve(packageDirectory, "package.json"),
            "utf8"
        )) as Record<string, unknown>;
        if (
            packageManifest.name !== "pillar-core-sdk" ||
            packageManifest.private !== true ||
            "publishConfig" in packageManifest
        ) {
            throw new Error("SDK staging package 必须使用预定包名并保持禁止发布");
        }

        const tarballDirectory = resolve(temporaryRoot, "tarball");
        const consumerDirectory = resolve(temporaryRoot, "consumer");
        await mkdir(tarballDirectory, {recursive: true});
        await mkdir(consumerDirectory, {recursive: true});
        await run([
            process.execPath,
            "pm",
            "pack",
            "--destination",
            tarballDirectory,
            "--ignore-scripts",
            "--quiet",
        ], packageDirectory);
        const tarballs = (await readdir(tarballDirectory))
            .filter((name) => name.endsWith(".tgz"));
        if (tarballs.length !== 1) {
            throw new Error(`SDK pack 应只生成一个 tarball，实际为 ${tarballs.length}`);
        }
        const tarball = resolve(tarballDirectory, tarballs[0]!);

        await writeFile(resolve(consumerDirectory, "package.json"), `${JSON.stringify({
            private: true,
            type: "module",
            dependencies: {"pillar-core-sdk": `file:${tarball}`},
        }, null, 2)}\n`, "utf8");
        // Do not invoke an installer: Bun's --offline can still contact registries.
        // Only declared direct dependencies are linked, so missing external declarations fail.
        const modules = resolve(consumerDirectory, "node_modules");
        const installedPackage = resolve(modules, "pillar-core-sdk");
        await mkdir(installedPackage, {recursive: true});
        await run(["tar", "-xzf", tarball, "-C", installedPackage, "--strip-components=1"], consumerDirectory);
        const dependencies: unknown = packageManifest.dependencies;
        if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("SDK dependencies 必须是对象");
        for (const name of Object.keys(dependencies)) {
            if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`非法依赖名：${name}`);
            const installed = resolve(repositoryRoot, "node_modules", name);
            await access(resolve(installed, "package.json"));
            const link = resolve(modules, name);
            await mkdir(dirname(link), {recursive: true});
            await symlink(installed, link, process.platform === "win32" ? "junction" : "dir");
        }

        await writeFile(
            resolve(consumerDirectory, "consumer.mjs"),
            await Bun.file(resolve(
                repositoryRoot,
                "tests",
                "fixtures",
                "sdkPackageConsumer.mjs"
            )).text(),
            "utf8"
        );
        await writeFile(
            resolve(consumerDirectory, "consumer.ts"),
            await Bun.file(resolve(
                repositoryRoot,
                "tests",
                "fixtures",
                "sdkPackageConsumer.ts.fixture"
            )).text(),
            "utf8"
        );

        const typecheck = await run([
            resolve(repositoryRoot, "node_modules", ".bin", "tsc"),
            "--noEmit",
            "--strict",
            "--target",
            "ES2024",
            "--lib",
            "ES2024,DOM",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "consumer.ts",
        ], consumerDirectory);
        if (typecheck) console.log(typecheck);

        for (const runtime of ["node", process.execPath]) {
            const runtimeName = runtime === "node" ? "node" : "bun";
            const workspace = resolve(temporaryRoot, `${runtimeName}-workspace`);
            const pillarHome = resolve(temporaryRoot, `${runtimeName}-home`);
            await mkdir(workspace, {recursive: true});
            await mkdir(pillarHome, {recursive: true});
            const output = await run([
                runtime,
                resolve(consumerDirectory, "consumer.mjs"),
                workspace,
                pillarHome,
            ], consumerDirectory);
            if (!output.includes(`SDK_PACKAGE_RUN_OK:${runtimeName}`)) {
                throw new Error(`${runtimeName} SDK smoke 缺少成功标记: ${output}`);
            }
            console.log(output);
        }
    } finally {
        await rm(temporaryRoot, {recursive: true, force: true});
    }
}

await main();
