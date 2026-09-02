import {dirname, extname, resolve} from "node:path";
import * as ts from "typescript";

const root = process.cwd();
const configPath = resolve(root, "tsconfig.production.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}
const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    undefined,
    configPath
);
if (parsed.errors.length > 0) {
    throw new Error(parsed.errors
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
        .join("\n"));
}

const files = new Set(parsed.fileNames.map((file) => resolve(file)));

function resolveLocalImport(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(from), specifier);
    const extension = extname(base);
    const candidates = extension === ".js" || extension === ".mjs" || extension === ".cjs"
        ? [
            base.slice(0, -extension.length) + ".ts",
            base.slice(0, -extension.length) + ".tsx",
        ]
        : extension
            ? [base]
            : [base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")];
    return candidates.find((candidate) => files.has(candidate));
}

const graph = new Map<string, Set<string>>();

function isTypeOnlyEdge(
    statement: ts.ImportDeclaration | ts.ExportDeclaration
): boolean {
    if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) return true;
        return Boolean(
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length > 0 &&
            statement.exportClause.elements.every((item) => item.isTypeOnly)
        );
    }
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    return Boolean(
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((item) => item.isTypeOnly)
    );
}

for (const file of files) {
    const content = ts.sys.readFile(file);
    if (content === undefined) continue;
    const source = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const edges = new Set<string>();
    for (const statement of source.statements) {
        if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            !isTypeOnlyEdge(statement) &&
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            const target = resolveLocalImport(file, statement.moduleSpecifier.text);
            if (target) edges.add(target);
        }
    }
    graph.set(file, edges);
}

let nextIndex = 0;
const indices = new Map<string, number>();
const lowLinks = new Map<string, number>();
const stack: string[] = [];
const onStack = new Set<string>();
const cycles: string[][] = [];

function visit(file: string): void {
    const index = nextIndex++;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    onStack.add(file);

    for (const target of graph.get(file) ?? []) {
        if (!indices.has(target)) {
            visit(target);
            lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(target)!));
        } else if (onStack.has(target)) {
            lowLinks.set(file, Math.min(lowLinks.get(file)!, indices.get(target)!));
        }
    }

    if (lowLinks.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    while (stack.length > 0) {
        const current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
        if (current === file) break;
    }
    if (
        component.length > 1 ||
        (component.length === 1 && graph.get(file)?.has(file))
    ) {
        cycles.push(component);
    }
}

for (const file of files) {
    if (!indices.has(file)) visit(file);
}

if (cycles.length > 0) {
    console.error(`发现 ${cycles.length} 个生产源码依赖环：`);
    for (const cycle of cycles) {
        console.error(cycle
            .map((file) => file.slice(root.length + 1))
            .sort()
            .map((file) => `- ${file}`)
            .join("\n"));
    }
    process.exit(1);
}

console.log(`生产源码依赖环审计通过：${files.size} files，0 cycles`);
