import {describe, expect, test} from "bun:test";
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
        await writeFile(join(source, "install.sh"), installer);
        await writeFile(join(root, "downloaded.sh"), installer);
        const mocks: Record<string, string> = {
            uname: 'printf "%s\\n" "${TEST_OS:-Darwin}"',
            curl: 'echo "Unexpected network access" >&2; exit 98',
            brew: 'printf "%s\\n" "$*" >> "$HOME/brew.log"; touch "$HOME/brew-installed"',
            rg: 'exit 0',
            git: `case "$1" in
  --version) echo git-test ;;
  clone)
    target="\${@: -1}"
    mkdir -p "$target/src" "$target/.git"
    touch "$target/src/index.tsx" "$target/bun.lock"
    echo clone >> "$HOME/git.log" ;;
  -C) echo "\${TEST_ORIGIN:-https://github.com/peihanm/pillar-core.git}" ;;
  *) exit 97 ;;
esac`,
            bun: `case "$1" in
  --version)
    if [[ "\${TEST_OLD_BUN:-0}" == 1 && ! -e "$HOME/brew-installed" ]]; then echo 1.2.0; else echo 1.3.14; fi ;;
  install) [[ "\${TEST_INSTALL_FAIL:-0}" != 1 ]] ;;
  link)
    mkdir -p "$HOME/global bin"
    printf '#!/bin/bash\\n[[ "$1" == --help ]]\\n' > "$HOME/global bin/pillar"
    chmod +x "$HOME/global bin/pillar" ;;
  pm) printf '%s\\n' "$HOME/global bin" ;;
  *) exit 97 ;;
esac`,
        };
        for (const [name, body] of Object.entries(mocks)) {
            const path = join(bin, name);
            await writeFile(path, `#!/bin/bash\nset -eu\n${body}\n`);
            await chmod(path, 0o755);
        }
        await run({home, source, execute: async (overrides = {}, remote = false) => {
            const child = Bun.spawn(["/bin/bash", join(remote ? root : source, remote ? "downloaded.sh" : "install.sh")], {
                cwd: root,
                env: {HOME: home, SHELL: "/bin/zsh", PATH: `${bin}:/usr/bin:/bin`, BUN_INSTALL: root, ...overrides},
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
            expect(output.trim()).toBe(join(home, "global bin/pillar"));
        });
    });

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
    });

    test("installs an outdated Bun through Homebrew", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({TEST_OLD_BUN: "1"})).toMatchObject({code: 0});
            expect(await readFile(join(home, "brew.log"), "utf8")).toBe("install oven-sh/bun/bun\n");
        });
    });

    test("downloaded installer clones once and refuses an unrelated destination", async () => {
        await fixture(async ({home, execute}) => {
            expect(await execute({}, true)).toMatchObject({code: 0});
            expect(await execute({}, true)).toMatchObject({code: 0});
            expect(await readFile(join(home, "git.log"), "utf8")).toBe("clone\n");
            const result = await execute({TEST_ORIGIN: "https://example.com/other.git"}, true);
            expect(result.code).toBe(1);
            expect(result.output).toContain("belongs to another repository");
        });
    });

    test("does not overwrite an existing non-repository directory", async () => {
        await fixture(async ({home, execute}) => {
            const target = join(home, ".local/share/pillar/source/keep.txt");
            await mkdir(dirname(target), {recursive: true});
            await writeFile(target, "user data");
            expect((await execute({}, true)).code).toBe(1);
            expect(await readFile(target, "utf8")).toBe("user data");
        });
    });

    test("failed dependency installation never reports success or edits shell config", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_INSTALL_FAIL: "1"});
            expect(result.code).not.toBe(0);
            expect(result.output).not.toContain("Pillar installed.");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    });

    test("rejects unsupported platforms before changing files", async () => {
        await fixture(async ({home, execute}) => {
            const result = await execute({TEST_OS: "Linux"});
            expect(result.code).toBe(1);
            expect(result.output).toContain("Only macOS");
            expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
        });
    });
});
