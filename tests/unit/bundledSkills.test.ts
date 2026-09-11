import {expect, test} from "bun:test";
import {loadBundledSkills} from "../../src/skills/bundled.js";

test("内置 Skill 加载入口保留，当前不注册默认工作流", () => {
    expect(loadBundledSkills()).toEqual([]);
});
