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
        if (++nodes > maxNodes || depth > maxDepth) throw new Error("JSON node count or depth exceeds the validation budget");
        if (item === null || typeof item === "boolean") bytes += 5;
        else if (typeof item === "number" && Number.isFinite(item)) bytes += 24;
        else if (typeof item === "string") {
            if (item.length > maxBytes) throw new Error("JSON string exceeds the validation budget");
            bytes += Buffer.byteLength(JSON.stringify(item));
        }
        else if (typeof item === "object" && item !== null) {
            if (ancestors.has(item)) throw new Error("Circular JSON objects are not supported");
            ancestors.add(item);
            if (Array.isArray(item)) for (const entry of item) visit(entry, depth + 1);
            else {
                if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Arguments must be a plain JSON object");
                for (const [key, entry] of Object.entries(item)) {
                    bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
                    visit(entry, depth + 1);
                }
            }
            ancestors.delete(item);
            bytes += 2;
        } else throw new Error("Arguments contain non-JSON values");
        if (bytes > maxBytes) throw new Error("JSON size exceeds the validation budget");
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
        if (++nodes > 2048 || depth > 32) throw new Error("Schema reference expansion exceeds 2048 nodes or 32 levels");
        if (typeof schema === "boolean") return;
        if (!object(schema)) throw new Error("Subschema must be an object or boolean");
        if (ancestors.has(schema)) throw new Error("Recursive Schema references are not supported");
        ancestors.add(schema);
        for (const key of ["$async", "$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor", "$anchor", "$vocabulary"]) {
            if (key in schema) throw new Error(`Unsupported Schema keyword ${key}`);
        }
        if (schema !== root && ("$id" in schema || "$schema" in schema)) throw new Error("Nested Schema dialects or IDs are not supported");
        if (schema.uniqueItems === true) hasUniqueItems = true;
        if (schema.$ref !== undefined) {
            const ref = schema.$ref;
            if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("Only non-recursive local JSON Pointer $ref references are supported");
            let target: unknown = root;
            for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
                if (/~(?:[^01]|$)/.test(part)) throw new Error("Invalid JSON Pointer escape");
                const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
                if ((!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw new Error("Local Schema reference does not exist");
                target = Reflect.get(target, key);
            }
            visit(target, depth + 1);
        }
        for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
            const map = schema[key];
            if (object(map) && Object.hasOwn(map, "__proto__")) throw new Error("__proto__ Schema property names are not supported");
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
        if (pattern.length > 1024) throw new Error("Schema regex exceeds the 1024-character budget");
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
    if (!ajv) throw new Error("Only JSON Schema draft-07, 2019-09 and 2020-12 (default) are supported");
    // Standard format implementations are fixed library code; bound their string inputs too.
    for (const [name, format] of Object.entries(fullFormats)) {
        if (typeof format === "boolean") {ajv.addFormat(name, format); continue;}
        if (typeof format === "string") throw new Error("String Format definitions are not supported");
        if (typeof format === "object" && !(format instanceof RegExp) && format.type === "number") {
            ajv.addFormat(name, format); continue;
        }
        const validate = typeof format === "function" || format instanceof RegExp ? format : (format as FormatDefinition<string>).validate;
        if (typeof validate === "string") throw new Error("String Format validators are not supported");
        ajv.addFormat(name, {type: "string", validate: (value: string) => {
            if (value.length > 2048) throw new Error("Format string exceeds the 2048-character validation budget");
            return validate instanceof RegExp ? validate.test(value) : validate(value);
        }});
    }
    const validate = ajv.compile(schema);
    const parameters = z.custom<Record<string, unknown>>(object, "MCP arguments must be a JSON object").superRefine((value, ctx) => {
        try {
            const size = measureJson(value, 256 * 1024, 10_000, 48);
            if (complexity.nodes * (size.bytes + size.nodes) * (complexity.hasUniqueItems ? size.nodes : 1) > 4_000_000) {
                throw new Error("MCP arguments and Schema exceed the validation work budget");
            }
            if (validate(value)) return;
            const error = validate.errors?.[0];
            ctx.addIssue({code: "custom", message: `MCP inputSchema ${error?.instancePath || "/"}: ${error?.message ?? "Validation failed"}`.slice(0, 500)});
        } catch (error) {
            ctx.addIssue({code: "custom", message: `MCP argument validation failed: ${error instanceof Error ? error.message : "Unknown error"}`.slice(0, 500)});
        }
    });
    return {schema, parameters};
}
