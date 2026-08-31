import {cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(repositoryRoot, "dist", "sdk-package");
const sdkDirectory = resolve(packageDirectory, "sdk");
const packageJsonPath = resolve(repositoryRoot, "package.json");
const SDK_PACKAGE_NAME = "pillar-core-sdk";

const runtimeDependencies = [
    "@anthropic-ai/sandbox-runtime",
    "@modelcontextprotocol/sdk",
    "diff",
    "string-width",
    "turndown",
    "yaml",
    "zod",
    "zod-to-json-schema",
] as const;

interface RootPackageJson {
    version?: unknown;
    dependencies?: unknown;
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`package.json 的 ${field} 必须是非空字符串`);
    }
    return value;
}

function readRuntimeDependencies(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("package.json 缺少 dependencies");
    }
    const source = value as Record<string, unknown>;
    return Object.fromEntries(runtimeDependencies.map((name) => [
        name,
        requireString(source[name], `dependencies.${name}`),
    ]));
}

async function runDeclarationBundler(output: string): Promise<void> {
    const executable = resolve(
        repositoryRoot,
        "node_modules",
        ".bin",
        "dts-bundle-generator"
    );
    const child = Bun.spawn([
        executable,
        "--no-banner",
        "--project",
        resolve(repositoryRoot, "tsconfig.sdk.json"),
        "-o",
        output,
        resolve(repositoryRoot, "src", "sdk", "index.ts"),
    ], {
        cwd: repositoryRoot,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`SDK 声明打包失败，exit code ${exitCode}`);
    }
}

function assertPackagePath(path: string): void {
    const expectedParent = resolve(repositoryRoot, "dist");
    if (dirname(path) !== expectedParent) {
        throw new Error(`拒绝清理非 SDK 构建目录: ${path}`);
    }
}

async function main(): Promise<void> {
    assertPackagePath(packageDirectory);
    const rootPackage = JSON.parse(
        await readFile(packageJsonPath, "utf8")
    ) as RootPackageJson;
    const version = requireString(rootPackage.version, "version");
    const dependencies = readRuntimeDependencies(rootPackage.dependencies);

    await rm(packageDirectory, {recursive: true, force: true});
    await mkdir(sdkDirectory, {recursive: true});

    const build = await Bun.build({
        entrypoints: [resolve(repositoryRoot, "src", "sdk", "index.ts")],
        outdir: sdkDirectory,
        target: "node",
        format: "esm",
        packages: "external",
        minify: false,
    });
    if (!build.success) {
        for (const log of build.logs) console.error(log);
        throw new Error("SDK ESM 构建失败");
    }

    const javascriptPath = resolve(sdkDirectory, "index.js");
    const declarationPath = resolve(sdkDirectory, "index.d.ts");
    await runDeclarationBundler(declarationPath);
    await cp(
        resolve(repositoryRoot, "src", "skills", "bundled-files"),
        resolve(sdkDirectory, "bundled-files"),
        {recursive: true}
    );
    await cp(
        resolve(repositoryRoot, "src", "lsp", "userInfoPatch.cjs"),
        resolve(sdkDirectory, "userInfoPatch.cjs")
    );
    await cp(
        resolve(repositoryRoot, "src", "sdk", "PACKAGE_README.md"),
        resolve(packageDirectory, "README.md")
    );

    const javascript = await readFile(javascriptPath, "utf8");
    if (/\bBun\./.test(javascript) || /import\.meta\.(?:dir|path)/.test(javascript)) {
        throw new Error("SDK 构建产物仍包含 Bun-only 运行时 API");
    }
    const declaration = await readFile(declarationPath, "utf8");
    const imports = declaration.match(/^\s*import\b.*$/gm) ?? [];
    if (
        imports.some((line) => !/\bfrom\s+["']zod["'];?\s*$/.test(line)) ||
        /\bfrom\s+["'](?:\.|\/)/.test(declaration)
    ) {
        throw new Error("SDK 声明文件包含非公开或内部类型依赖");
    }

    const publishedPackage = {
        name: SDK_PACKAGE_NAME,
        version,
        private: true,
        description: "Pillar TypeScript SDK",
        type: "module",
        exports: {
            ".": {
                types: "./sdk/index.d.ts",
                import: "./sdk/index.js",
            },
        },
        files: ["sdk", "README.md"],
        engines: {
            node: ">=22.12.0",
            bun: ">=1.3.0",
        },
        dependencies,
    };
    await writeFile(
        resolve(packageDirectory, "package.json"),
        `${JSON.stringify(publishedPackage, null, 2)}\n`,
        "utf8"
    );

    console.log(
        `SDK package built: ${relative(repositoryRoot, packageDirectory)}`
    );
}

await main();
