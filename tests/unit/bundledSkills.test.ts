import {expect, test} from "bun:test";
import {loadBundledSkills} from "../../src/skills/bundled.js";

test("the product guide is available without restoring removed workflows", () => {
    expect(loadBundledSkills().map(skill => skill.name)).toEqual(["hicode-guide"]);
});
