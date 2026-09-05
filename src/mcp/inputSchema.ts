import {z} from "zod";
import {Ajv} from "ajv";
import {Ajv2019} from "ajv/dist/2019.js";
import {Ajv2020} from "ajv/dist/2020.js";
import {fullFormats} from "ajv-formats/dist/formats.js";
import {RE2JS} from "re2js";
import type {FormatDefinition, Options} from "ajv";

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function measureJson(value: unknown, maxBytes: number, maxNodes: number, maxDepth: number) {
    let nodes = 0;
    let bytes = 0;
    const ancestors = new Set<object>();
    const visit = (item: unknown, depth: number): void => {
        if (++nodes > maxNodes || depth > maxDepth) throw new Error("JSON 节点数或深度超过校验预算");
        if (item === null || typeof item === "boolean") bytes += 5;
        else if (typeof item === "number" && Number.isFinite(item)) bytes += 24;
        else if (typeof item === "string") {
            if (item.length > maxBytes) throw new Error("JSON 字符串超过校验预算");
            bytes += Buffer.byteLength(JSON.stringify(item));
        }
        else if (typeof item === "object" && item !== null) {
            if (ancestors.has(item)) throw new Error("不支持循环 JSON 对象");
            ancestors.add(item);
            if (Array.isArray(item)) for (const entry of item) visit(entry, depth + 1);
            else {
                if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("参数必须是普通 JSON 对象");
                for (const [key, entry] of Object.entries(item)) {
                    bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
                    visit(entry, depth + 1);
                }
            }
            ancestors.delete(item);
            bytes += 2;
        } else throw new Error("参数包含非 JSON 值");
        if (bytes > maxBytes) throw new Error("JSON 大小超过校验预算");
    };
    visit(value, 0);
    return {nodes, bytes};
}

/** Bound reference expansion before Ajv compilation; refs never trigger network or filesystem reads. */
function inspectSchema(root: Record<string, unknown>) {
    let nodes = 0;
    let hasUniqueItems = false;
    const ancestors = new Set<object>();
    const visit = (schema: unknown, depth: number): void => {
        if (++nodes > 2048 || depth > 32) throw new Error("Schema 引用展开超过 2048 节点或 32 层预算");
        if (typeof schema === "boolean") return;
        if (!object(schema)) throw new Error("子 Schema 必须是 object 或 boolean");
        if (ancestors.has(schema)) throw new Error("不支持递归 Schema 引用");
        ancestors.add(schema);
        for (const key of ["$async", "$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor", "$anchor", "$vocabulary"]) {
            if (key in schema) throw new Error(`不支持 Schema 关键字 ${key}`);
        }
        if (schema !== root && ("$id" in schema || "$schema" in schema)) throw new Error("不支持嵌套 Schema dialect 或 ID");
        if (schema.uniqueItems === true) hasUniqueItems = true;
        if (schema.$ref !== undefined) {
            const ref = schema.$ref;
            if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("只支持本 Schema 内非递归 JSON Pointer $ref");
            let target: unknown = root;
            for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
                if (/~(?:[^01]|$)/.test(part)) throw new Error("非法 JSON Pointer 转义");
                const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
                if ((!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw new Error("Schema 本地引用不存在");
                target = Reflect.get(target, key);
            }
            visit(target, depth + 1);
        }
        for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
            const map = schema[key];
            if (object(map) && Object.hasOwn(map, "__proto__")) throw new Error("不支持 __proto__ Schema 属性名");
            if (object(map)) for (const child of Object.values(map)) {
                if (key === "dependencies" && Array.isArray(child)) continue;
                visit(child, depth + 1);
            }
        }
        for (const key of ["items", "prefixItems", "allOf", "anyOf", "oneOf", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
            const child = schema[key];
            if (child !== undefined) {
                if (Array.isArray(child)) for (const entry of child) visit(entry, depth + 1);
                else visit(child, depth + 1);
            }
        }
        ancestors.delete(schema);
    };
    visit(root, 0);
    return {nodes, hasUniqueItems};
}

export function compileMcpInputSchema(rawSchema: Record<string, unknown>) {
    measureJson(rawSchema, 64 * 1024, 4096, 48);
    const schema = structuredClone(rawSchema);
    const complexity = inspectSchema(schema);
    const dialect = schema.$schema;
    const regExp = Object.assign((pattern: string, flags: string) => {
        if (pattern.length > 1024) throw new Error("Schema 正则超过 1024 字符预算");
        const compiled = RE2JS.compile(RE2JS.translateRegExp(new RegExp(pattern, flags)));
        return {test: (value: string) => compiled.matcher(value).find(), toString: () => `/${pattern}/${flags}`};
    }, {code: "mcpRegExp"});
    const options: Options = {
        strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
        allowUnionTypes: true, allowMatchingProperties: true, allErrors: false,
        coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true,
        inlineRefs: false, loopEnum: 32, loopRequired: 32, logger: false,
        code: {regExp},
    };
    const ajv = dialect === undefined || dialect === "https://json-schema.org/draft/2020-12/schema" || dialect === "https://json-schema.org/draft/2020-12/schema#"
        ? new Ajv2020(options)
        : dialect === "https://json-schema.org/draft/2019-09/schema" || dialect === "https://json-schema.org/draft/2019-09/schema#"
            ? new Ajv2019(options)
            : dialect === "http://json-schema.org/draft-07/schema#" || dialect === "http://json-schema.org/draft-07/schema"
                ? new Ajv(options)
                : undefined;
    if (!ajv) throw new Error("只支持 JSON Schema draft-07、2019-09、2020-12（默认）");
    // Standard format implementations are fixed library code; bound their string inputs too.
    for (const [name, format] of Object.entries(fullFormats)) {
        if (typeof format === "boolean") {ajv.addFormat(name, format); continue;}
        if (typeof format === "string") throw new Error("不支持字符串 Format 定义");
        if (typeof format === "object" && !(format instanceof RegExp) && format.type === "number") {
            ajv.addFormat(name, format); continue;
        }
        const validate = typeof format === "function" || format instanceof RegExp ? format : (format as FormatDefinition<string>).validate;
        if (typeof validate === "string") throw new Error("不支持字符串 Format validator");
        ajv.addFormat(name, {type: "string", validate: (value: string) => {
            if (value.length > 2048) throw new Error("Format 字符串超过 2048 字符校验预算");
            return validate instanceof RegExp ? validate.test(value) : validate(value);
        }});
    }
    const validate = ajv.compile(schema);
    const parameters = z.custom<Record<string, unknown>>(object, "MCP 参数必须是 JSON Object").superRefine((value, ctx) => {
        try {
            const size = measureJson(value, 256 * 1024, 10_000, 48);
            if (complexity.nodes * (size.bytes + size.nodes) * (complexity.hasUniqueItems ? size.nodes : 1) > 4_000_000) {
                throw new Error("MCP 参数与 Schema 组合超过校验工作量预算");
            }
            if (validate(value)) return;
            const error = validate.errors?.[0];
            ctx.addIssue({code: "custom", message: `MCP inputSchema ${error?.instancePath || "/"}: ${error?.message ?? "校验失败"}`.slice(0, 500)});
        } catch (error) {
            ctx.addIssue({code: "custom", message: `MCP 参数校验失败: ${error instanceof Error ? error.message : "未知错误"}`.slice(0, 500)});
        }
    });
    return {schema, parameters};
}
