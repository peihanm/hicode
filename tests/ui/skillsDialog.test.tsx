import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import type {LoadedSkill} from "../../src/skills/types.js";
import {SkillsDialog} from "../../src/ui/skills/SkillsDialog.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

afterEach(cleanup);
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const skill: LoadedSkill = {
    name: "westock-data", source: "project", filePath: "/workspace/.hicode/skills/westock-data/SKILL.md",
    description: "金融市场结构化数据查询。" + "支持股票、基金、财报与行业数据。".repeat(10),
    content: "PRIVATE_SKILL_BODY",
};

test("compact list, scrollable details and two-level Escape reflow on narrow terminals", async () => {
    let closed = 0;
    const view = render(<SkillsDialog skills={[skill]} projectDirectory="/workspace/.hicode/skills"
        userDirectory="/user/skills" onClose={() => closed++}/>);
    let columns = 80;
    Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
    Object.defineProperty(view.stdout, "rows", {configurable: true, value: 24});
    for (const width of [80, 36]) {
        columns = width; view.stdout.emit("resize");
        await new Promise(resolve => setTimeout(resolve, 110));
        const list = view.lastFrame() ?? "";
        expect(list).toContain("westock-data");
        expect(list).toContain("Project");
        expect(list).not.toContain("SKILL.md");
        expect(list).not.toContain("Restart HiCode");
        expect(list).not.toMatch(/[╭╰│]/);
        expect(list.split("\n").length).toBeLessThan(12);
        view.stdin.write("\r"); await tick();
        const frames = [view.lastFrame() ?? ""];
        for (let i = 0; i < 28; i++) {view.stdin.write("\u001b[B"); await tick(); frames.push(view.lastFrame() ?? "");}
        expect(frames.join("\n")).toContain("SKILL.md");
        expect(frames.join("\n")).not.toContain("PRIVATE_SKILL_BODY");
        expect([list, ...frames].every(frame => frame.split("\n").every(line => stringWidth(line) <= width))).toBe(true);
        view.stdin.write("\u001b"); await tick();
        expect(view.lastFrame()).toContain("Enter details");
        expect(closed).toBe(0);
    }
    view.stdin.write("\u001b"); await tick();
    expect(closed).toBe(1);
});

test("long lists keep the last Skill reachable and represent Host identity correctly", async () => {
    const skills: LoadedSkill[] = Array.from({length: 12}, (_, i) => ({
        name: `host-${i}`, source: "host", id: `inline-${i}`, description: "Review code", content: "body",
    }));
    const view = render(<SkillsDialog skills={skills} projectDirectory="/project" userDirectory="/user" onClose={() => {}}/>);
    await tick();
    expect(view.lastFrame()).not.toContain("host-11");
    for (let i = 0; i < 11; i++) {view.stdin.write("\u001b[B"); await tick();}
    expect(view.lastFrame()).toContain("host-11");
    view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("inline-11");
    expect(view.lastFrame()).toContain("no local file");
    expect(view.lastFrame()).not.toContain("undefined");
});

test("empty state explains where to install Skills and closes with Escape", async () => {
    let closed = false;
    const view = render(<SkillsDialog skills={[]} projectDirectory="/project/.hicode/skills"
        userDirectory="/custom-home/skills" onClose={() => {closed = true;}}/>);
    await tick();
    expect(view.lastFrame()).toContain("No Skills loaded.");
    expect(view.lastFrame()).toContain("/custom-home/skills");
    view.stdin.write("\u001b"); await tick();
    expect(closed).toBe(true);
});

test("/skills opens a local panel without invoking the Agent or printing the verbose report", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd, {skills: [skill]});
        let calls = 0;
        const view = render(<AppForTest resources={resources} runAgentImpl={async () => {
            calls++; return {reply: "unexpected", reason: "completed", iterations: 1};
        }}/>);
        try {
            await tick(); view.stdin.write("/skills"); await tick(); view.stdin.write("\r"); await tick();
            expect(view.lastFrame()).toContain("◆ Skills");
            expect(view.lastFrame()).toContain("Enter details");
            expect(view.lastFrame()).not.toContain("Path:");
            expect(view.lastFrame()).not.toContain("Worked for");
            expect(view.lastFrame()).not.toContain("Ask HiCode");
            view.stdin.write("\u001b"); await tick();
            expect(view.lastFrame()).toContain("Ask HiCode");
            expect(calls).toBe(0);
        } finally {view.unmount(); await resources.close();}
    });
});
