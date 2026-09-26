import {describe, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const installer = await readFile(fileURLToPath(new URL("../../install.sh", import.meta.url)), "utf8");

async function fixture(run: (context: {
    home: string;
    source: string;
    publish(version: string): Promise<void>;
    runInstalled(): Promise<{code: number; output: string}>;
    execute(overrides?: Record<string, string>, remote?: boolean): Promise<{code: number; output: string}>;
}) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "hicode-installer-"));
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
            getconf: '[[ "${TEST_MUSL:-0}" != 1 ]] && echo "glibc 2.36"',
            bwrap: 'echo "Unexpected system bwrap execution" >&2; exit 98',
            socat: 'echo "Unexpected system socat execution" >&2; exit 98',
            sudo: 'echo "Unexpected sudo execution" >&2; exit 98',
            "apt-get": 'echo "Unexpected apt-get execution" >&2; exit 98',
            uname: 'if [[ "$1" == -m ]]; then echo "${TEST_ARCH:-arm64}"; else echo "${TEST_OS:-Darwin}"; fi',
            curl: `[[ "\${TEST_ALLOW_DOWNLOAD:-0}" == 1 ]] || exit 98
[[ "\${TEST_DOWNLOAD_FAIL:-0}" != 1 ]] || exit 22
for arg in "$@"; do
  case "$arg" in
    https://registry.npmjs.org/@oven/*) package=bun ;;
    https://registry.npmjs.org/@vscode/*) package=rg ;;
    https://codeload.github.com/*) package=source ;;
    https://github.com/peihanm/hicode/releases/download/*) package=runtime ;;
    https://api.github.com/repos/peihanm/hicode/releases/assets/*)
      [[ "\${TEST_RUNTIME_API_FAIL:-0}" != 1 ]] || exit 22
      package=runtime ;;
  esac
done
printf '%s\\n' "$package" >> "$HOME/download.log"
cp "$TEST_ARCHIVES/$package.tgz" "\${@: -1}"
if [[ "\${TEST_BAD_CHECKSUM:-0}" == 1 ]]; then printf corrupt >> "\${@: -1}"; fi`,
            brew: 'echo "Unexpected Homebrew execution" >&2; exit 98',
            git: 'echo "Unexpected Git execution" >&2; exit 98',
            rm: `for arg in "$@"; do
  if [[ "\${TEST_PRUNE_FAIL:-0}" == 1 && "$arg" == */releases/* ]]; then exit 13; fi
done
exec /bin/rm "$@"`,
            rg: '[[ "${TEST_MISSING_RG:-0}" != 1 || -f "$HOME/.local/share/hicode/bin/rg" ]]',
            bun: `case "$1" in
  --version)
    if [[ "\${TEST_OLD_BUN:-0}" == 1 && ! -e "$HOME/.local/share/hicode/bin/bun" ]]; then echo 1.2.0; else echo 1.3.14; fi ;;
  install) [[ "\${TEST_INSTALL_FAIL:-0}" != 1 ]] ;;
  */src/index.tsx) [[ "$2" == --help && "\${TEST_START_FAIL:-0}" != 1 ]] && cat "$1" ;;
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
        const helpers = join(root, "helpers");
        await mkdir(join(helpers, "bin"), {recursive: true});
        for (const name of ["bwrap", "socat"]) {
            const path = join(helpers, "bin", name);
            await writeFile(path, `#!/bin/bash\n[[ "$1" == --version || "$1" == -V || "\${TEST_NAMESPACE_FAIL:-0}" != 1 ]]\n`);
            await chmod(path, 0o755);
            const hash = createHash("sha256").update(await readFile(path)).digest("hex");
            fixtureInstaller = fixtureInstaller.replace(new RegExp(`${name}_checksum=[A-Za-z0-9_]+`, "g"), `${name}_checksum=${hash}`);
        }
        const helperArchive = join(archives, "runtime.tgz");
        const pack = Bun.spawn(["/usr/bin/tar", "-czf", helperArchive, "-C", helpers, "bin"]);
        expect(await pack.exited).toBe(0);
        const helperHash = createHash("sha256").update(await readFile(helperArchive)).digest("hex");
        fixtureInstaller = fixtureInstaller.replace(/runtime_checksum=[A-Za-z0-9_]+/g, `runtime_checksum=${helperHash}`);
        await writeFile(join(source, "install.sh"), fixtureInstaller);
        await writeFile(join(root, "downloaded.sh"), fixtureInstaller);
        const remote = join(root, "hicode-main");
        await mkdir(join(remote, "src"), {recursive: true});
        await writeFile(join(remote, "src/index.tsx"), "");
        await writeFile(join(remote, "bun.lock"), "");
        await writeFile(join(remote, "install.sh"), fixtureInstaller);
        const publish = async (version: string) => {
            await writeFile(join(remote, "src/index.tsx"), version);
            const tar = Bun.spawn(["/usr/bin/tar", "-czf", join(archives, "source.tgz"), "-C", root, "hicode-main"]);
            expect(await tar.exited).toBe(0);
        };
        await publish("v1");
        await run({home, source, publish, runInstalled: async () => {
            const child = Bun.spawn([join(home, ".local/share/hicode/bin/hicode"), "--help"], {
                cwd: root, env: {HOME: home, PATH: `${bin}:/usr/bin:/bin`}, stdout: "pipe", stderr: "pipe",
            });
            const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
            return {code, output};
        }, execute: async (overrides = {}, remote = false) => {
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

describe("macOS/Linux installer (offline command fixtures)", () => {
    test("preserves shell config, handles spaces and quotes, and installs only once in PATH", async () => {
        await fixture(async ({home, execute}) => {
            await writeFile(join(home, ".zshrc"), "# existing user config\n");
            expect(await execute()).toMatchObject({code: 0});
            expect(await execute()).toMatchObject({code: 0});
            const config = await readFile(join(home, ".zshrc"), "utf8");
            expect(config.startsWith("# existing user config\n")).toBe(true);
            expect(config.match(/# HiCode installer/g)).toHaveLength(1);
            // Evaluate the generated PATH as a fresh interactive shell would.
            const child = Bun.spawn(["/bin/bash", "-c", 'source "$HOME/.zshrc"; command -v hicode; hicode --help'], {
                env: {HOME: home, PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe",
            });
            const output = await new Response(child.stdout).text();
            expect(await child.exited).toBe(0);
            expect(output.trim()).toBe(join(home, ".local/share/hicode/bin/hicode"));
        });
    }, 20_000);

    test("honors ZDOTDIR and bash login configuration", async () => {
        await fixture(async ({home, execute}) => {
            const zdotdir = join(home, "zsh config");
            expect(await execute({ZDOTDIR: zdotdir})).toMatchObject({code: 0});
            expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toContain("# HiCode installer");
            await writeFile(join(home, ".profile"), "# login config\n");
            expect(await execute({SHELL: "/bin/bash"})).toMatchObject({code: 0});
            expect(await readFile(join(home, ".profile"), "utf8")).toContain("# login config\n");
            expect(await readFile(join(home, ".bashrc"), "utf8")).toContain("# HiCode installer");
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
            expect(await Bun.file(join(home, ".local/share/hicode/bin/bun")).exists()).toBe(false);
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);

    test("installs v1, switches to v2, then removes the old release and preserves config", async () => {
        await fixture(async ({home, execute, publish, runInstalled}) => {
            const config = join(home, ".hicode/settings.json");
            await mkdir(dirname(config));
            await writeFile(config, '{"fixture":"preserve"}');
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            expect(await runInstalled()).toEqual({code: 0, output: "v1"});
            const oldEntry = await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8");
            const oldReleases = await readdir(join(home, ".local/share/hicode/releases"));
            await publish("v2");
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            expect(await runInstalled()).toEqual({code: 0, output: "v2"});
            expect(await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8")).not.toBe(oldEntry);
            expect(await readFile(config, "utf8")).toBe('{"fixture":"preserve"}');
            const releases = await readdir(join(home, ".local/share/hicode/releases"));
            expect(releases).toHaveLength(1);
            expect(releases).not.toEqual(oldReleases);
            // The same archive is reused without editing an active release's dependencies.
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1", TEST_INSTALL_FAIL: "1"}, true)).toMatchObject({code: 0});
            expect(await readdir(join(home, ".local/share/hicode/releases"))).toEqual(releases);
            expect((await readFile(join(home, ".zshrc"), "utf8")).match(/# HiCode installer/g)).toHaveLength(1);
        });
    }, 20_000);

    test("download, dependency and startup failures preserve the old launcher and settings", async () => {
        await fixture(async ({home, execute, publish, runInstalled}) => {
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            const entry = await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8");
            const shell = await readFile(join(home, ".zshrc"), "utf8");
            await publish("v2");
            for (const failure of ["TEST_DOWNLOAD_FAIL", "TEST_INSTALL_FAIL", "TEST_START_FAIL"]) {
                const result = await execute({TEST_ALLOW_DOWNLOAD: "1", [failure]: "1"}, true);
                expect(result.code).not.toBe(0);
                expect(result.output).not.toContain("HiCode installed.");
                expect(await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8")).toBe(entry);
                expect(await readFile(join(home, ".zshrc"), "utf8")).toBe(shell);
                expect(await runInstalled()).toEqual({code: 0, output: "v1"});
                expect(await readdir(join(home, ".local/share/hicode/releases"))).toHaveLength(1);
            }
        });
    }, 20_000);

    test("pruning skips unknown directories, symlinks and developer checkouts", async () => {
        await fixture(async ({home, execute, publish, runInstalled}) => {
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            const root = join(home, ".local/share/hicode");
            const releases = join(root, "releases");
            const unknown = join(releases, "a".repeat(64));
            const checkout = join(releases, "b".repeat(64));
            const external = join(home, "external");
            for (const directory of [unknown, checkout, external, join(root, "source")]) {
                await mkdir(directory, {recursive: true});
                await writeFile(join(directory, "keep.txt"), "user data");
            }
            await writeFile(join(checkout, ".install-ready"), "ready\n");
            await writeFile(join(checkout, ".git"), "gitdir: elsewhere\n");
            await writeFile(join(external, ".install-ready"), "ready\n");
            await symlink(external, join(releases, "c".repeat(64)));
            await publish("v2");
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            expect(await runInstalled()).toEqual({code: 0, output: "v2"});
            for (const directory of [unknown, checkout, external, join(root, "source")]) {
                expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("user data");
            }
        });
    }, 20_000);

    test("failed old-version cleanup reports a warning and keeps the new entry working", async () => {
        await fixture(async ({home, execute, publish, runInstalled}) => {
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            await publish("v2");
            const result = await execute({TEST_ALLOW_DOWNLOAD: "1", TEST_PRUNE_FAIL: "1"}, true);
            expect(result.code).toBe(0);
            expect(result.output).toContain("could not remove old version");
            expect(await runInstalled()).toEqual({code: 0, output: "v2"});
            expect(await readdir(join(home, ".local/share/hicode/releases"))).toHaveLength(2);
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            expect(await readdir(join(home, ".local/share/hicode/releases"))).toHaveLength(1);
        });
    }, 20_000);

    test("remote update never replaces a developer checkout launcher", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute()).toMatchObject({code: 0});
            const entry = await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8");
            const result = await execute({TEST_ALLOW_DOWNLOAD: "1"}, true);
            expect(result.code).not.toBe(0);
            expect(result.output).toContain("source checkout");
            expect(await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8")).toBe(entry);
        });
    }, 20_000);

    test("removes a recognized previous source-layout installation only after successful update", async () => {
        await fixture(async ({home, execute, runInstalled}) => {
            expect(await execute()).toMatchObject({code: 0});
            const command = join(home, ".local/share/hicode/bin/hicode");
            const previous = await readFile(command, "utf8");
            const legacySource = join(home, ".local/share/hicode/source");
            await mkdir(join(legacySource, "src"), {recursive: true});
            await writeFile(join(legacySource, "src/index.tsx"), "legacy");
            await writeFile(join(legacySource, "bun.lock"), "");
            // Ask Bash to quote the historical path exactly as the old installer did.
            const quoted = Bun.spawn(["/bin/bash", "-c", 'printf "%q" "$1"', "fixture", join(legacySource, "src/index.tsx")], {stdout: "pipe"});
            const path = await new Response(quoted.stdout).text();
            expect(await quoted.exited).toBe(0);
            const exec = previous.split("\n").find(line => line.startsWith("exec "))!;
            const bunEnd = exec.indexOf(" ", 5); // Fixture's Bun path is outside the quoted home directory.
            await writeFile(command, `#!/bin/bash\n${exec.slice(0, bunEnd)} ${path} "$@"\n`);
            expect((await execute({TEST_ALLOW_DOWNLOAD: "1", TEST_START_FAIL: "1"}, true)).code).not.toBe(0);
            expect(await readFile(join(legacySource, "src/index.tsx"), "utf8")).toBe("legacy");
            expect(await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).toMatchObject({code: 0});
            expect(await runInstalled()).toEqual({code: 0, output: "v1"});
            expect(await Bun.file(join(legacySource, "src/index.tsx")).exists()).toBe(false);
        });
    }, 20_000);

    test("rejects concurrent installation and symlink launchers without overwriting them", async () => {
        await fixture(async ({home, execute}) => {
            const root = join(home, ".local/share/hicode");
            await mkdir(join(root, ".install.lock"), {recursive: true});
            expect((await execute()).output).toContain("Another installer");
            await rm(join(root, ".install.lock"), {recursive: true});
            await mkdir(join(root, "bin"));
            const target = join(home, "keep");
            await writeFile(target, "user data");
            await symlink(target, join(root, "bin/hicode"));
            expect((await execute({TEST_ALLOW_DOWNLOAD: "1"}, true)).code).not.toBe(0);
            expect(await readFile(target, "utf8")).toBe("user data");
        });
    }, 20_000);

    test("does not overwrite an existing non-repository directory", async () => {
        await fixture(async ({home, execute}) => {
            const target = join(home, ".local/share/hicode/source/keep.txt");
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
            expect(result.output).not.toContain("HiCode installed.");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);

    test("rejects unsupported platforms before changing files", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OS: "FreeBSD"});
            expect(result.code).toBe(1);
            expect(result.output).toContain("Only macOS");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);
    for (const arch of ["aarch64", "x86_64"]) test(`Linux ${arch} bootstraps verified binaries and a Bash launcher`, async () => {
        await fixture(async ({home, execute, runInstalled}) => {
            const result = await execute({TEST_OS: "Linux", TEST_ARCH: arch, SHELL: "/bin/bash",
                TEST_OLD_BUN: "1", TEST_MISSING_RG: "1", TEST_ALLOW_DOWNLOAD: "1"});
            expect(result).toMatchObject({code: 0});
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("bun\nrg\nruntime\n");
            expect(await readFile(join(home, ".bashrc"), "utf8")).toContain("# HiCode installer");
            expect(await runInstalled()).toMatchObject({code: 0});
        });
    }, 20_000);
    test("unsupported Linux libc fails before creating installation files", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({TEST_OS: "Linux", TEST_MUSL: "1"})).toMatchObject({code: 1});
            expect(await Bun.file(join(home, ".bashrc")).exists()).toBe(false);
        });
    }, 20_000);
    test("Linux installs and reuses private runtime helpers without sudo or system tools", async () => {
        await fixture(async ({home, execute, runInstalled}) => {
            const env = {TEST_OS: "Linux", TEST_ARCH: "aarch64", TEST_ALLOW_DOWNLOAD: "1", SHELL: "/bin/bash"};
            expect(await execute(env)).toMatchObject({code: 0});
            expect(await execute(env)).toMatchObject({code: 0});
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("runtime\n");
            expect(await readFile(join(home, ".local/share/hicode/bin/hicode"), "utf8")).toContain("export HICODE_LINUX_RUNTIME_DIR=");
            expect(await runInstalled()).toMatchObject({code: 0});
        });
    }, 20_000);
    test("Linux runtime download falls back to the public release URL when the API is unavailable", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OS: "Linux", TEST_ARCH: "aarch64", TEST_ALLOW_DOWNLOAD: "1", TEST_RUNTIME_API_FAIL: "1"});
            expect(result.code).toBe(0);
            expect(result.output).toContain("Trying the GitHub release download URL");
            expect(await readFile(join(home, "download.log"), "utf8")).toBe("runtime\n");
        });
    }, 20_000);
    test("Linux refuses corrupt downloaded or cached helpers", async () => {
        await fixture(async ({home, execute}) => {
            const env = {TEST_OS: "Linux", TEST_ARCH: "aarch64", TEST_ALLOW_DOWNLOAD: "1"};
            expect(await execute({...env, TEST_BAD_CHECKSUM: "1"})).toMatchObject({code: 1});
            expect(await Bun.file(join(home, ".local/share/hicode/bin/hicode")).exists()).toBe(false);
            expect(await execute(env)).toMatchObject({code: 0});
            await writeFile(join(home, ".local/share/hicode/runtime/linux-runtime-v1-arm64/bin/bwrap"), "corrupt");
            const result = await execute(env);
            expect(result.code).toBe(1);
            expect(result.output).toContain("Installed Linux runtime is damaged");
        });
    }, 20_000);
    test("blocked namespaces fail before publishing a launcher without changing security policy", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OS: "Linux", TEST_ARCH: "aarch64", TEST_ALLOW_DOWNLOAD: "1", TEST_NAMESPACE_FAIL: "1"});
            expect(result.code).toBe(1);
            expect(result.output).toContain("host blocks sandbox setup");
            expect(await Bun.file(join(home, ".local/share/hicode/bin/hicode")).exists()).toBe(false);
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    }, 20_000);
});
