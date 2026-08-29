import * as ts from "typescript";
import {dirname, isAbsolute, relative, resolve} from "node:path";

type CandidateKind = "export" | "member";
type FindingKind =
    | "UNUSED_MEMBER"
    | "TEST_ONLY_EXPORT"
    | "TEST_ONLY_MEMBER"
    | "POSSIBLE_TEST_ONLY_MEMBER";

interface Candidate {
    kind: CandidateKind;
    fileName: string;
    position: number;
    name: string;
    owner?: string;
}

interface ReferenceLocation {
    file: string;
    line: number;
    column: number;
    write: boolean;
}

interface Finding {
    kind: FindingKind;
    symbol: string;
    file: string;
    line: number;
    productionReads: number;
    productionWrites: number;
    externalProductionReferences: number;
    testReads: number;
    testWrites: number;
    testReferences: ReferenceLocation[];
}

const root = process.cwd();
const sourceRoot = resolve(root, "src");
const testRoot = resolve(root, "tests");
const jsonOutput = process.argv.includes("--json");
const failOnFindings = process.argv.includes("--fail-on-findings");
const includeAmbiguousMembers = process.argv.includes("--include-ambiguous-members");

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function isInside(fileName: string, directory: string): boolean {
    const path = relative(directory, resolve(fileName));
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isExported(node: ts.Node): boolean {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function identifierName(node: ts.Node | undefined): ts.Identifier | undefined {
    return node && ts.isIdentifier(node) ? node : undefined;
}

function collectExportCandidates(sourceFile: ts.SourceFile): Candidate[] {
    const candidates: Candidate[] = [];
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement) && isExported(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                const name = identifierName(declaration.name);
                if (!name) continue;
                candidates.push({
                    kind: "export",
                    fileName: sourceFile.fileName,
                    position: name.getStart(sourceFile),
                    name: name.text,
                });
            }
            continue;
        }
        if (
            !isExported(statement) ||
            !(
                ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)
            )
        ) {
            continue;
        }
        const name = identifierName(statement.name);
        if (!name) continue;
        candidates.push({
            kind: "export",
            fileName: sourceFile.fileName,
            position: name.getStart(sourceFile),
            name: name.text,
        });
    }
    return candidates;
}

function memberContainer(node: ts.Node): {name: string; exported: boolean} | undefined {
    const parent = node.parent;
    if (
        ts.isClassDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent)
    ) {
        const name = identifierName(parent.name);
        return name ? {name: name.text, exported: isExported(parent)} : undefined;
    }
    if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) {
        const alias = parent.parent;
        return {name: alias.name.text, exported: isExported(alias)};
    }
    return undefined;
}

function isAuditableMember(node: ts.Node): node is
    | ts.PropertySignature
    | ts.MethodSignature
    | ts.PropertyDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration {
    return ts.isPropertySignature(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node);
}

function collectMemberCandidates(sourceFile: ts.SourceFile): Candidate[] {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (isAuditableMember(node)) {
            const container = memberContainer(node);
            const name = identifierName(node.name);
            if (
                container?.exported &&
                name &&
                !hasModifier(node, ts.SyntaxKind.PrivateKeyword) &&
                !hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
            ) {
                const key = `${container.name}\u0000${name.text}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    candidates.push({
                        kind: "member",
                        fileName: sourceFile.fileName,
                        position: name.getStart(sourceFile),
                        name: name.text,
                        owner: container.name,
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return candidates;
}

function createLanguageService(configPath: string): {
    service: ts.LanguageService;
    program: ts.Program;
} {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
        fail(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    }
    const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath
    );
    if (parsed.errors.length > 0) {
        fail(parsed.errors
            .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
            .join("\n"));
    }
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => parsed.fileNames,
        getScriptVersion: () => "0",
        getScriptSnapshot(fileName) {
            const content = ts.sys.readFile(fileName);
            return content === undefined
                ? undefined
                : ts.ScriptSnapshot.fromString(content);
        },
        getCurrentDirectory: () => root,
        getCompilationSettings: () => parsed.options,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = service.getProgram();
    if (!program) fail("无法创建 TypeScript Program");
    return {service, program};
}

function sourcePosition(
    program: ts.Program,
    fileName: string,
    position: number
): {line: number; column: number} {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return {line: 0, column: 0};
    const location = sourceFile.getLineAndCharacterOfPosition(position);
    return {line: location.line + 1, column: location.character + 1};
}

function collectReferences(
    service: ts.LanguageService,
    program: ts.Program,
    candidate: Candidate
): ReferenceLocation[] {
    const groups = service.findReferences(candidate.fileName, candidate.position) ?? [];
    return groups.flatMap((group) => group.references)
        .filter((reference) => !reference.isDefinition)
        .map((reference) => {
            const location = sourcePosition(
                program,
                reference.fileName,
                reference.textSpan.start
            );
            return {
                file: resolve(reference.fileName),
                line: location.line,
                column: location.column,
                write: reference.isWriteAccess,
            };
        });
}

function countReferences(references: ReferenceLocation[]): {
    reads: number;
    writes: number;
} {
    return references.reduce(
        (count, reference) => {
            if (reference.write) count.writes += 1;
            else count.reads += 1;
            return count;
        },
        {reads: 0, writes: 0}
    );
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return undefined;
}

function collectProductionPropertyUses(sourceFiles: ts.SourceFile[]): ReadonlyMap<string, number> {
    const uses = new Map<string, number>();
    const record = (name: string | undefined): void => {
        if (!name) return;
        uses.set(name, (uses.get(name) ?? 0) + 1);
    };
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) {
            record(node.name.text);
        } else if (
            ts.isElementAccessExpression(node) &&
            node.argumentExpression &&
            (ts.isStringLiteral(node.argumentExpression) ||
                ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
        ) {
            record(node.argumentExpression.text);
        } else if (ts.isBindingElement(node)) {
            record(propertyNameText(node.propertyName ?? node.name));
        } else if (ts.isPropertyAssignment(node)) {
            record(propertyNameText(node.name));
        } else if (ts.isShorthandPropertyAssignment(node)) {
            record(node.name.text);
        } else if (ts.isJsxAttribute(node)) {
            record(ts.isIdentifier(node.name) ? node.name.text : node.name.getText());
        }
        ts.forEachChild(node, visit);
    };
    for (const sourceFile of sourceFiles) visit(sourceFile);
    return uses;
}

function findCandidateIssues(
    service: ts.LanguageService,
    program: ts.Program,
    candidates: Candidate[],
    productionPropertyUses: ReadonlyMap<string, number>
): Finding[] {
    const findings: Finding[] = [];
    for (const candidate of candidates) {
        const references = collectReferences(service, program, candidate);
        const productionReferences = references.filter((reference) =>
            isInside(reference.file, sourceRoot)
        );
        const externalProductionReferences = productionReferences.filter(
            (reference) => resolve(reference.file) !== resolve(candidate.fileName)
        );
        const testReferences = references.filter((reference) =>
            isInside(reference.file, testRoot)
        );
        const production = countReferences(productionReferences);
        const tests = countReferences(testReferences);
        let kind: FindingKind | undefined;
        if (candidate.kind === "export") {
            if (
                testReferences.length > 0 &&
                externalProductionReferences.length === 0
            ) {
                kind = "TEST_ONLY_EXPORT";
            }
        } else if (
            production.reads === 0 &&
            production.writes === 0
        ) {
            if ((productionPropertyUses.get(candidate.name) ?? 0) === 0) {
                kind = testReferences.length > 0
                    ? "TEST_ONLY_MEMBER"
                    : "UNUSED_MEMBER";
            } else if (includeAmbiguousMembers && testReferences.length > 0) {
                kind = "POSSIBLE_TEST_ONLY_MEMBER";
            }
        }
        if (!kind) continue;

        const declaration = sourcePosition(
            program,
            candidate.fileName,
            candidate.position
        );
        findings.push({
            kind,
            symbol: candidate.owner
                ? `${candidate.owner}.${candidate.name}`
                : candidate.name,
            file: relative(root, candidate.fileName),
            line: declaration.line,
            productionReads: production.reads,
            productionWrites: production.writes,
            externalProductionReferences: externalProductionReferences.length,
            testReads: tests.reads,
            testWrites: tests.writes,
            testReferences: testReferences.map((reference) => ({
                ...reference,
                file: relative(root, reference.file),
            })),
        });
    }
    return findings.sort((left, right) =>
        left.file.localeCompare(right.file, "en") ||
        left.line - right.line ||
        left.symbol.localeCompare(right.symbol, "en")
    );
}

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.test.json");
if (!configPath) fail("找不到 tsconfig.test.json");
const {service, program} = createLanguageService(configPath);
const sourceFiles = program.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile && isInside(sourceFile.fileName, sourceRoot)
);
const exportCandidates = sourceFiles.flatMap(collectExportCandidates);
const memberCandidates = sourceFiles.flatMap(collectMemberCandidates);
const productionPropertyUses = collectProductionPropertyUses(sourceFiles);
const findings = findCandidateIssues(
    service,
    program,
    [...exportCandidates, ...memberCandidates],
    productionPropertyUses
);

if (jsonOutput) {
    console.log(JSON.stringify({
        analyzed: {
            files: sourceFiles.length,
            exports: exportCandidates.length,
            members: memberCandidates.length,
        },
        findings,
    }, null, 2));
} else {
    console.log(
        `测试专用生产 API 审计：${sourceFiles.length} files · ` +
        `${exportCandidates.length} exports · ${memberCandidates.length} members`
    );
    if (findings.length === 0) {
        console.log("没有发现生产零引用、测试有引用的候选。");
    } else {
        console.log(`发现 ${findings.length} 个候选（仅报告，不自动删除）：`);
        console.log(
            "TEST_ONLY_EXPORT 表示没有其他生产模块引用该导出；定义文件内部仍可能使用其实现。"
        );
        if (includeAmbiguousMembers) {
            console.log(
                "POSSIBLE_TEST_ONLY_MEMBER 表示存在同名生产属性，但 TypeScript 无法确认是否属于该成员。"
            );
        }
        for (const finding of findings) {
            console.log(
                `\n[${finding.kind}] ${finding.file}:${finding.line} ${finding.symbol}`
            );
            console.log(
                `  production reads ${finding.productionReads} · writes ${finding.productionWrites}` +
                ` · external ${finding.externalProductionReferences}`
            );
            console.log(
                `  tests reads ${finding.testReads} · writes ${finding.testWrites}`
            );
            for (const reference of finding.testReferences.slice(0, 5)) {
                console.log(
                    `  - ${reference.file}:${reference.line}:${reference.column}`
                );
            }
            if (finding.testReferences.length > 5) {
                console.log(`  - … ${finding.testReferences.length - 5} more`);
            }
        }
    }
}

if (failOnFindings && findings.length > 0) process.exitCode = 1;
