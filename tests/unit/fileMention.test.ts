import {expect, test} from "bun:test";
import {completeFileMention, fileMentionAt} from "../../src/ui/input/fileMention.js";

test("file mentions follow the cursor and do not treat emails or paste capsules as completions", () => {
    expect(fileMentionAt({value: "check @in later", cursorOffset: 9})).toEqual({start: 6, end: 9, query: "in"});
    expect(fileMentionAt({value: "@input", cursorOffset: 3})).toEqual({start: 0, end: 6, query: "in"});
    expect(fileMentionAt({value: "你好 @", cursorOffset: 4})).toEqual({start: 3, end: 4, query: ""});
    expect(fileMentionAt({value: "看看@src", cursorOffset: 6})).toEqual({start: 2, end: 6, query: "src"});
    expect(fileMentionAt({value: "name@example.com", cursorOffset: 16})).toBeUndefined();
    expect(fileMentionAt({value: "@inside", cursorOffset: 7}, [{id: 1, start: 0, end: 7}])).toBeUndefined();
    expect(fileMentionAt({value: "@first @second", cursorOffset: 14})).toEqual({start: 7, end: 14, query: "second"});
});

test("completion replaces only the active token and quotes paths without corrupting the suffix", () => {
    const state = {value: "check @in later", cursorOffset: 9};
    expect(completeFileMention(state, fileMentionAt(state)!, "src/中文 file.ts")).toEqual({
        value: 'check "src/中文 file.ts" later', cursorOffset: 22,
    });
    const middle = {value: "@input", cursorOffset: 3};
    expect(completeFileMention(middle, fileMentionAt(middle)!, "src/InputBox.tsx")).toEqual({value: "src/InputBox.tsx ", cursorOffset: 17});
});
