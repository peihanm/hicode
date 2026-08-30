import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";

const root = process.cwd();
const referenceRoot = resolve(root, "docs/reference");
const findings: string[] = [];

function existsSourceReference(value: string): boolean {
    const target = resolve(root, value);
    if (existsSync(target)) return true;
    if (!value.endsWith(".js")) return false;
    const withoutExtension = target.slice(0, -3);
    return existsSync(withoutExtension + ".ts") || existsSync(withoutExtension + ".tsx");
}

for (const name of readdirSync(referenceRoot).filter((file) => file.endsWith(".md"))) {
    const file = resolve(referenceRoot, name);
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
            const raw = match[1]!;
            if (/^(?:https?:|mailto:)/.test(raw)) continue;
            const path = raw.split("#", 1)[0]!;
            if (path && !existsSync(resolve(dirname(file), path))) {
                findings.push(`${name}:${index + 1} 不存在的文档链接 ${raw}`);
            }
        }
        for (const match of line.matchAll(/`(src\/[^`\s]+)`/g)) {
            const path = match[1]!.replace(/[,:;.)]+$/, "");
            if (/[<>{}*]/.test(path)) continue;
            if (!existsSourceReference(path)) {
                findings.push(`${name}:${index + 1} 不存在的源码路径 ${path}`);
            }
        }
    }
}

if (findings.length > 0) {
    console.error(`reference 路径审计发现 ${findings.length} 个问题：\n${findings.join("\n")}`);
    process.exit(1);
}

console.log("reference 路径审计通过：本地链接与显式 src 路径均存在");
