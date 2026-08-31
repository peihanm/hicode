import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(repositoryRoot, "dist", "sdk-package");

async function run(
    command: string[],
    cwd: string,
    environment?: NodeJS.ProcessEnv
): Promise<string> {
    const child = Bun.spawn(command, {
        cwd,
        env: environment ?? process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
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
            [process.execPath, resolve(repositoryRoot, "scripts/build-sdk-package.ts")],
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
        await run([
            process.execPath,
            "install",
            "--offline",
            "--ignore-scripts",
            "--no-progress",
        ], consumerDirectory, {
            ...process.env,
            TMPDIR: temporaryRoot,
        });

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
