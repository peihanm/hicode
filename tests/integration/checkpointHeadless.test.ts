import {describe, expect, test} from "bun:test";
import {mkdir, readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";
import {getSessionLogPath} from "../../src/session/paths.js";

const repositoryRoot = resolve(import.meta.dir, "..", "..");

async function run(command: string[], options: {
    cwd: string;
    env: Record<string, string | undefined>;
}) {
    const process = Bun.spawn(command, {
        cwd: options.cwd,
        env: options.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    return {stdout, stderr, exitCode};
}

describe("Checkpoint Headless CLI", () => {
    test("显式 session/checkpoint 以纯 JSON 恢复代码与对话且退出 0", async () => {
        await withTempProject(async (cwd) => {
            const home = join(cwd, ".home");
            await mkdir(home, {recursive: true});
            const env = {...process.env, HOME: home};
            const setup = await run([
                process.execPath,
                join(repositoryRoot, "tests/fixtures/checkpointCliSetup.ts"),
                cwd,
            ], {cwd: repositoryRoot, env});
            expect(setup.exitCode).toBe(0);
            const identity = JSON.parse(setup.stdout) as {
                sessionId: string;
                checkpointId: string;
            };

            const forked = await run([process.execPath, join(repositoryRoot, "src/index.tsx"),
                "-r", identity.sessionId, "--fork-from", identity.checkpointId, "--output-format", "json"], {cwd, env});
            expect(forked.exitCode).toBe(0);
            expect(forked.stderr).toBe("");
            expect(JSON.parse(forked.stdout)).toMatchObject({status: "complete", filesChanged: false});
            expect(JSON.parse(forked.stdout).sessionId).not.toBe(identity.sessionId);
            expect(await readFile(join(cwd, "headless.txt"), "utf8")).toBe("after\n");

            const restored = await run([
                process.execPath,
                join(repositoryRoot, "src/index.tsx"),
                "-r",
                identity.sessionId,
                "--rewind",
                identity.checkpointId,
                "--output-format",
                "json",
            ], {cwd, env});

            expect({
                exitCode: restored.exitCode,
                stdout: restored.stdout,
                stderr: restored.stderr,
            }).toMatchObject({exitCode: 0});
            expect(restored.stderr).toBe("");
            expect(JSON.parse(restored.stdout)).toMatchObject({
                status: "complete",
                checkpointId: identity.checkpointId,
                restoredFiles: ["headless.txt"],
            });
            expect(JSON.parse(restored.stdout)).not.toHaveProperty("mode");
            expect(await readFile(join(cwd, "headless.txt"), "utf8"))
                .toBe("before\n");
            const sessionEntries = (await readFile(
                getSessionLogPath(
                    createPillarStorageLayout({pillarHome: join(home, ".pillar")}),
                    cwd,
                    identity.sessionId
                ),
                "utf8"
            )).trim().split("\n").map((line) => JSON.parse(line) as unknown);
            expect(sessionEntries.at(-1)).toMatchObject({
                type: "snapshot",
                conversation: [],
            });
        });
    });
});
