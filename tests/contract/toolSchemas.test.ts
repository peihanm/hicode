import {describe, expect, test} from "bun:test";
import {Ajv} from "ajv";
import {z} from "zod";
import {createToolCatalog} from "../../src/tools/catalog.js";
import {adaptPillarHostTools, definePillarTool} from "../../src/sdk/hostTools.js";

describe("Function parameter JSON Schema", () => {
    test("所有内置工具满足 JSON Schema Draft 7 元规范", () => {
        const validator = new Ajv({strict: false});
        for (const registration of createToolCatalog({}).registrations) {
            const schema = registration.schema().function.parameters;
            expect(validator.validateSchema(schema), registration.tool.name).toBe(true);
        }
    });

    test("view_image 裁剪宽高保持正整数约束且可以编译", () => {
        const registration = createToolCatalog({}).registrations.find(item => item.tool.name === "view_image")!;
        const validate = new Ajv({strict: false}).compile(registration.schema().function.parameters);
        const input = {path: "image.png", region: {x: 0, y: 0, width: 1, height: 1}};
        expect(validate(input)).toBe(true);
        for (const field of ["width", "height"] as const) {
            for (const value of [0, -1, 0.5, true]) {
                expect(validate({...input, region: {...input.region, [field]: value}})).toBe(false);
            }
        }
    });

    test("SDK Zod 工具保留排他上界、下界和 nullable 语义", () => {
        const tools = adaptPillarHostTools([definePillarTool({
            name: "host_bounded", description: "Bounded input", readOnly: true,
            parameters: z.object({value: z.number().gt(0).lt(1), note: z.string().nullable()}),
            execute() { return "ok"; },
        })]);
        const registration = createToolCatalog({additionalTools: tools}).registrations.find(item => item.tool.name === "host_bounded")!;
        const validate = new Ajv({strict: false}).compile(registration.schema().function.parameters);
        expect(validate({value: 0.5, note: null})).toBe(true);
        expect(validate({value: 0.5, note: "text"})).toBe(true);
        for (const value of [0, 1, -1, true]) expect(validate({value, note: null})).toBe(false);
        expect(validate({value: 0.5, note: 1})).toBe(false);
    });
});
