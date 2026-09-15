import {describe, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const installer = await readFile(fileURLToPath(new URL("../../install.sh", import.meta.url)), "utf8");

async function fixture(run: (context: {
    home: string;
    source: string;
    execute(overrides?: Record<string, string>, remote?: boolean): Promise<{code: number; output: string}>;
}) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "pillar-installer-"));
    const home = join(root, "user's home");
    const bin = join(root, "bin");
    const source = join(root, "source code");
    try {
        await mkdir(home, {recursive: true});
        await mkdir(bin);
        await mkdir(join(source, "src"), {recursive: true});
        await writeFile(join(source, "src/index.tsx"), "");
        await writeFile(join(source, "bun.lock"), "");
        const mocks: Record<string, string> = {
            uname: 'if [[ "$1" == -m ]]; then echo "${TEST_ARCH:-arm64}"; else echo "${TEST_OS:-Darwin}"; fi',
            curl: `[[ "\${TEST_ALLOW_DOWNLOAD:-0}" == 1 ]] || exit 98
for arg in "$@"; do
  case "$arg" in
    https://registry.npmjs.org/@oven/*) package=bun ;;
    https://registry.npmjs.org/@vscode/*) package=rg ;;
    https://codeload.github.com/*) package=source ;;
  esac
done
printf '%s\\n' "$package" >> "$HOME/download.log"
cp "$TEST_ARCHIVES/$package.tgz" "\${@: -1}"
if [[ "\${TEST_BAD_CHECKSUM:-0}" == 1 ]]; then printf corrupt >> "\${@: -1}"; fi`,
            brew: 'echo "Unexpected Homebrew execution" >&2; exit 98',
            git: 'echo "Unexpected Git execution" >&2; exit 98',
            rg: '[[ "${TEST_MISSING_RG:-0}" != 1 || -f "$HOME/.local/share/pillar/bin/rg" ]]',
            bun: `case "$1" in
  --version)
    if [[ "\${TEST_OLD_BUN:-0}" == 1 && ! -e "$HOME/.local/share/pillar/bin/bun" ]]; then echo 1.2.0; else echo 1.3.14; fi ;;
  install) [[ "\${TEST_INSTALL_FAIL:-0}" != 1 ]] ;;
  */src/index.tsx) [[ "$2" == --help ]] ;;
  *) exit 97 ;;
esac`,
        };
        for (const [name, body] of Object.entries(mocks)) {
            const path = join(bin, name);
            await writeFile(path, `#!/bin/bash\nset -eu\n${body}\n`);
            await chmod(path, 0o755);
        }
        // Serve local archives through curl; use their real checksums to exercise verification.
        const archives = join(root, "archives");
        const packageDir = join(root, "payload/package/bin");
        await mkdir(archives);
        await mkdir(packageDir, {recursive: true});
        let fixtureInstaller = installer;
        for (const name of ["bun", "rg"]) {
            const file = join(packageDir, name);
            await writeFile(file, `#!/bin/bash\nset -eu\n${mocks[name]}\n`);
            await chmod(file, 0o755);
            const archive = join(archives, `${name}.tgz`);
            const tar = Bun.spawn(["/usr/bin/tar", "-czf", archive, "-C", join(root, "payload"), `package/bin/${name}`]);
            expect(await tar.exited).toBe(0);
            const hash = createHash("sha512").update(await readFile(archive)).digest("hex");
            fixtureInstaller = fixtureInstaller.replace(new RegExp(`${name}_checksum=[a-f0-9]+`, "g"), `${name}_checksum=${hash}`);
        }
        await writeFile(join(source, "install.sh"), fixtureInstaller);
        await writeFile(join(root, "downloaded.sh"), fixtureInstaller);
        const remote = join(root, "pillar-core-main");
        await mkdir(join(remote, "src"), {recursive: true});
        await writeFile(join(remote, "src/index.tsx"), "");
        await writeFile(join(remote, "bun.lock"), "");
        await writeFile(join(remote, "install.sh"), fixtureInstaller);
        const tar = Bun.spawn(["/usr/bin/tar", "-czf", join(archives, "source.tgz"), "-C", root, "pillar-core-main"]);
        expect(await tar.exited).toBe(0);
        await run({home, source, execute: async (overrides = {}, remote = false) => {
            const child = Bun.spawn(["/bin/bash", join(remote ? root : source, remote ? "downloaded.sh" : "install.sh")], {
                cwd: root,
                env: {HOME: home, SHELL: "/bin/zsh", PATH: `${bin}:/usr/bin:/bin`, BUN_INSTALL: root, TEST_ARCHIVES: archives, ...overrides},
                stdout: "pipe", stderr: "pipe",
            });
            const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            return {code, output: stdout + stderr};
        }});
    } finally {
        await rm(root, {recursive: true, force: true});
    }
}

describe("macOS installer (offline command fixtures)", () => {
    test("preserves shell config, handles spaces and quotes, and installs only once in PATH", async () => {
        await fixture(async ({home, execute}) => {
            await writeFile(join(home, ".zshrc"), "# existing user config\n");
            expect(await execute()).toMatchObject({code: 0});
            expect(await execute()).toMatchObject({code: 0});
            const config = await readFile(join(home, ".zshrc"), "utf8");
            expect(config.startsWith("# existing user config\n")).toBe(true);
            expect(config.match(/# Pillar installer/g)).toHaveLength(1);
            // Evaluate the generated PATH as a fresh interactive shell would.
            const child = Bun.spawn(["/bin/zsh", "-c", 'source "$HOME/.zshrc"; command -v pillar; pillar --help'], {
                env: {HOME: home, PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe",
            });
            const output = await new Response(child.stdout).text();
            expect(await child.exited).toBe(0);
            expect(output.trim()).toBe(join(home, ".local/share/pillar/bin/pillar"));
        });
    }, 20_000);

    test("honors ZDOTDIR and bash login configuration", async () => {
        await fixture(async ({home, execute}) => {
            const zdotdir = join(home, "zsh config");
            expect(await execute({ZDOTDIR: zdotdir})).toMatchObject({code: 0});
            expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toContain("# Pillar installer");
            await writeFile(join(home, ".profile"), "# login config\n");
            expect(await execute({SHELL: "/bin/bash"})).toMatchObject({code: 0});
            expect(await readFile(join(home, ".profile"), "utf8")).toContain("# login config\n");
            expect(await readFile(join(home, ".bashrc"), "utf8")).toContain("# Pillar installer");
            expect(await Bun.file(join(home, ".bash_profile")).exists()).toBe(false);
        });
    }, 20_000);

    test("installs an outdated Bun directly with checksum verification and no Homebrew", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({TEST_OLD_BUN: "1", TEST_ALLOW_DOWNLOAD: "1"})).toMatchObject({code: 0});
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("bun\n");
        });
    }, 20_000);

    test("downloads ripgrep for Intel when no working executable is available", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({TEST_ARCH: "x86_64", TEST_MISSING_RG: "1", TEST_ALLOW_DOWNLOAD: "1"})).toMatchObject({code: 0});
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("rg\n");
        });
    }, 20_000);

    test("rejects corrupt binary downloads before installation or shell changes", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OLD_BUN: "1", TEST_ALLOW_DOWNLOAD: "1", TEST_BAD_CHECKSUM: "1"});
            expect(result.code).not.toBe(0);
            expect(await Bun.file(join(home, ".local/share/pillar/bin/bun")).exists()).toBe(false);
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);

    test("downloads source without Git and preserves it on a repeated remote install", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            const result = await execute({}, true);
            expect(result.code).toBe(1);
            expect(result.output).toContain("To repair that installation");
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("source\n");
        });
    }, 20_000);

    test("does not overwrite an existing non-repository directory", async () => {
        await fixture(async ({home, execute}) => {
            const target = join(home, ".local/share/pillar/source/keep.txt");
            await mkdir(dirname(target), {recursive: true});
            await writeFile(target, "user data");
            expect((await execute({}, true)).code).toBe(1);
            expect(await readFile(target, "utf8")).toBe("user data");
        });
    }, 20_000);

    test("failed dependency installation never reports success or edits shell config", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_INSTALL_FAIL: "1"});
            expect(result.code).not.toBe(0);
            expect(result.output).not.toContain("Pillar installed.");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);

    test("rejects unsupported platforms before changing files", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OS: "Linux"});
            expect(result.code).toBe(1);
            expect(result.output).toContain("Only macOS");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);
});
