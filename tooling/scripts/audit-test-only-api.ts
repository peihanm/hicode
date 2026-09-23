import * as ts from "typescript";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";

type CandidateKind = "export" | "member";
type FindingKind =
    | "UNUSED_EXPORT"
    | "LOCAL_ONLY_EXPORT"
    | "TOOLING_ONLY_EXPORT"
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
    toolingReferences: ReferenceLocation[];
}

const root = process.cwd();
const sourceRoot = resolve(root, "src");
const testRoot = resolve(root, "tests");
const toolingRoot = resolve(root, "tooling");
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

function isTestFile(fileName: string): boolean {
    if (isInside(fileName, testRoot)) return true;
    if (!isInside(fileName, toolingRoot)) return false;
    return relative(toolingRoot, resolve(fileName)).split(sep).includes("tests");
}

let productionFiles = new Set<string>();
function isNonTestConsumer(fileName: string): boolean {
    return productionFiles.has(resolve(fileName));
}

function productionReachability(program: ts.Program): Set<string> {
    const result = new Set<string>();
    const visitFile = (fileName: string) => {
        fileName = resolve(fileName);
        if (result.has(fileName) || !isInside(fileName, sourceRoot)) return;
        const file = program.getSourceFile(fileName);
        if (!file) return;
        result.add(fileName);
        const visit = (node: ts.Node) => {
            const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
                : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
            if (specifier && ts.isStringLiteral(specifier)) {
                const target = ts.resolveModuleName(specifier.text, fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
                if (target) visitFile(target.resolvedFileName);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    };
    visitFile(resolve(sourceRoot, "index.tsx"));
    visitFile(resolve(sourceRoot, "sdk/index.ts"));
    return result;
}

function nodeAt(file: ts.SourceFile, position: number): ts.Node {
    let result: ts.Node = file;
    const visit = (node: ts.Node) => {
        if (node.getStart(file) <= position && position < node.end) {result = node; ts.forEachChild(node, visit);}
    };
    visit(file);
    return result;
}

function isImportReference(program: ts.Program, fileName: string, position: number): boolean {
    const file = program.getSourceFile(fileName);
    if (!file) return false;
    for (let node: ts.Node | undefined = nodeAt(file, position); node; node = node.parent) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return true;
    }
    return false;
}

/** Follow the SDK's exposed types, not the implementation bodies or every SDK file. */
function sdkPublicSymbols(program: ts.Program): Set<ts.Symbol> {
    const checker = program.getTypeChecker();
    const symbols = new Set<ts.Symbol>(), seenTypes = new Set<ts.Type>();
    const visitType = (type: ts.Type) => {
        if (seenTypes.has(type)) return;
        seenTypes.add(type);
        if (type.isUnionOrIntersection()) type.types.forEach(visitType);
        if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
            checker.getTypeArguments(type as ts.TypeReference).forEach(visitType);
        }
        if (type.aliasSymbol) visitSymbol(type.aliasSymbol);
        if (type.symbol) {
            if (!type.symbol.declarations?.some(decl => isInside(decl.getSourceFile().fileName, sourceRoot))) return;
            symbols.add(type.symbol);
        }
        for (const property of checker.getPropertiesOfType(type)) visitSymbol(property);
        for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
            visitType(checker.getReturnTypeOfSignature(signature));
            signature.parameters.forEach(visitSymbol);
        }
    };
    const visitSymbol = (input: ts.Symbol) => {
        const symbol = input.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(input) : input;
        if (symbols.has(symbol)) return;
        const declarations = symbol.declarations ?? [];
        const declaration = declarations.find(decl => isInside(decl.getSourceFile().fileName, sourceRoot));
        if (!declaration || declarations.some(decl => hasModifier(decl, ts.SyntaxKind.PrivateKeyword) || hasModifier(decl, ts.SyntaxKind.ProtectedKeyword))) return;
        symbols.add(symbol);
        if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) visitType(checker.getDeclaredTypeOfSymbol(symbol));
        else visitType(checker.getTypeOfSymbolAtLocation(symbol, declaration));
    };
    const entry = program.getSourceFile(resolve(sourceRoot, "sdk/index.ts"));
    const module = entry && checker.getSymbolAtLocation(entry);
    if (module) checker.getExportsOfModule(module).forEach(visitSymbol);
    return symbols;
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

function createLanguageService(configPaths: string[]): {
    service: ts.LanguageService;
    program: ts.Program;
} {
    const parsedConfigs = configPaths.map((configPath) => {
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
                .map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
                )
                .join("\n"));
        }
        return parsed;
    });
    const fileNames = [...new Set(parsedConfigs.flatMap((parsed) => parsed.fileNames))];
    const options = parsedConfigs[0]?.options;
    if (!options) fail("至少需要一个 TypeScript 审计配置");
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => fileNames,
        getScriptVersion: () => "0",
        getScriptSnapshot(fileName) {
            const content = ts.sys.readFile(fileName);
            return content === undefined
                ? undefined
                : ts.ScriptSnapshot.fromString(content);
        },
        getCurrentDirectory: () => root,
        getCompilationSettings: () => options,
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
        .filter((reference) => !reference.isDefinition && !isImportReference(program, reference.fileName, reference.textSpan.start))
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
    productionPropertyUses: ReadonlyMap<string, number>,
    publicSymbols: ReadonlySet<ts.Symbol>
): Finding[] {
    const findings: Finding[] = [];
    for (const candidate of candidates) {
        const file = program.getSourceFile(candidate.fileName);
        const symbol = file && program.getTypeChecker().getSymbolAtLocation(nodeAt(file, candidate.position));
        if (symbol && publicSymbols.has(symbol)) continue;
        const references = collectReferences(service, program, candidate);
        const productionReferences = references.filter((reference) =>
            isNonTestConsumer(reference.file)
        );
        const externalProductionReferences = productionReferences.filter(
            (reference) => resolve(reference.file) !== resolve(candidate.fileName)
        );
        const testReferences = references.filter((reference) =>
            isTestFile(reference.file)
        );
        const toolingReferences = references.filter(reference => !isTestFile(reference.file) && isInside(reference.file, toolingRoot));
        const production = countReferences(productionReferences);
        const tests = countReferences(testReferences);
        let kind: FindingKind | undefined;
        if (candidate.kind === "export") {
            if (externalProductionReferences.length === 0) {
                kind = productionReferences.length ? "LOCAL_ONLY_EXPORT" : toolingReferences.length ? "TOOLING_ONLY_EXPORT"
                    : testReferences.length ? "TEST_ONLY_EXPORT" : "UNUSED_EXPORT";
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
            toolingReferences: toolingReferences.map(reference => ({...reference, file: relative(root, reference.file)})),
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

const configPaths = ["tsconfig.test.json", "tsconfig.tooling.json"].map((name) =>
    resolve(root, name)
);
for (const configPath of configPaths) {
    if (!ts.sys.fileExists(configPath)) fail(`找不到 ${relative(root, configPath)}`);
}
const {service, program} = createLanguageService(configPaths);
productionFiles = productionReachability(program);
const publicSymbols = sdkPublicSymbols(program);
const sourceFiles = program.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile && isInside(sourceFile.fileName, sourceRoot)
);
const nonTestFiles = program.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile && isNonTestConsumer(sourceFile.fileName)
);
const exportCandidates = sourceFiles.flatMap(collectExportCandidates);
const memberCandidates = sourceFiles.flatMap(collectMemberCandidates);
const productionPropertyUses = collectProductionPropertyUses(nonTestFiles);
const findings = findCandidateIssues(
    service,
    program,
    [...exportCandidates, ...memberCandidates],
    productionPropertyUses,
    publicSymbols
);

if (jsonOutput) {
    console.log(JSON.stringify({
        analyzed: {
            files: sourceFiles.length,
            productionFiles: productionFiles.size,
            publicApiSymbols: publicSymbols.size,
            exports: exportCandidates.length,
            members: memberCandidates.length,
        },
        publicApi: [...publicSymbols].flatMap(symbol => {
            const declaration = symbol.declarations?.[0];
            return declaration ? [{symbol: symbol.name, file: relative(root, declaration.getSourceFile().fileName)}] : [];
        }),
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
            "TEST_ONLY_EXPORT 没有生产读取；LOCAL_ONLY_EXPORT 仍有同文件生产使用；PUBLIC API 单独列出，不作为删除候选。"
        );
        console.log("生产消费者仅统计 CLI/SDK 可达 src；普通 tooling 单列，tests 不计入生产，re-export 不作为最终消费者。");
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
                `  non-test reads ${finding.productionReads} · writes ${finding.productionWrites}` +
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
