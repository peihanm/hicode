import {expect, test} from "bun:test";
import {analyzeReadCommand} from "../../src/permissions/shellRead.js";

test("read-command analysis separates patterns, options, paths and complete pipelines", () => {
    expect(analyzeReadCommand("rg -n -F -e 'a.b()' -g '*.ts' 'src with spaces' | head -n 20")).toMatchObject({
        kind: "search", pattern: "a.b()", paths: ["src with spaces"], singleSearch: false,
        segments: [{program: "rg", next: "|"}, {program: "head"}],
    });
    expect(analyzeReadCommand("rg --files -g '*.ts' src")).toMatchObject({kind: "files", paths: ["src"]});
    expect(analyzeReadCommand("rg -e '-leading' -- '中文 file.txt'")).toMatchObject({pattern: "-leading", paths: ["中文 file.txt"], singleSearch: true});
    expect(analyzeReadCommand("ls -la")).toMatchObject({kind: "directory", paths: ["."]});
    expect(analyzeReadCommand("rg word src && ls tests")).toMatchObject({paths: ["src", "tests"], segments: [{next: "&&"}, {program: "ls"}]});
});

test("read-only recognition rejects executable options, redirection and uncertain syntax", () => {
    for (const command of ["rg --pre ./run x .", "rg --hostname-bin ./run x .", "rg --pre=./run x .",
        "rg --pr ./run x .", "rg -z x .", "rg x . > output", "rg x . && rm file", "rg x $(pwd)",
        "rg x `pwd`", "PATH=. rg x .", "rg x . | xargs sh", "rg x . | tail -f", "rg -e", "rg --glob *.ts x", "rg x . &&"] ) {
        expect(analyzeReadCommand(command)).toBeUndefined();
    }
});
