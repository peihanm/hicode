import {describe, expect, test} from "bun:test";
import {BracketedPasteDecoder} from "../../src/ui/input/bracketedPaste.js";

const start = "\x1b[200~", end = "\x1b[201~";
describe("terminal paste stream", () => {
    test("every split in both markers preserves one complete paste and surrounding input", () => {
        for (let a = 1; a < start.length; a++) for (let b = 1; b < end.length; b++) {
            const decoder = new BracketedPasteDecoder();
            const events = [
                ...decoder.push("prefix" + start.slice(0, a)),
                ...decoder.push(start.slice(a) + "中文\r"),
                ...decoder.push("\nsecond\x03\t" + end.slice(0, b)),
                ...decoder.push(end.slice(b) + "\r"),
            ];
            expect(events).toEqual([{type:"input",text:"prefix"}, {type:"paste_start"},
                {type:"paste",text:"中文\r\nsecond\x03\t"}, {type:"input",text:"\r"}]);
        }
    });
    test("separate pastes stay separate, including an empty paste", () => {
        expect(new BracketedPasteDecoder().push(start + "one" + end + start + end + start + "two" + end))
            .toEqual([{type:"paste_start"},{type:"paste",text:"one"},
                {type:"paste_start"},{type:"paste",text:""},{type:"paste_start"},{type:"paste",text:"two"}]);
    });
    test("incomplete paste cannot be flushed as keystrokes", () => {
        const decoder = new BracketedPasteDecoder();
        expect(decoder.push(start + "1\r\x03\x1b[20")).toEqual([{type:"paste_start"}]);
        expect(decoder.hasPendingKey).toBe(false);
        expect(decoder.flushKey()).toBe("");
        expect(decoder.push("1~")).toEqual([{type:"paste",text:"1\r\x03"}]);
    });
    test("ordinary arrows and partial Escape remain keys", () => {
        const decoder = new BracketedPasteDecoder();
        expect(decoder.push("\x1b[A")).toEqual([{type:"input",text:"\x1b[A"}]);
        expect(decoder.push("\x1b")).toEqual([]);
        expect(decoder.hasPendingKey).toBe(true);
        expect(decoder.flushKey()).toBe("\x1b");
        expect(decoder.push("x")).toEqual([{type:"input",text:"x"}]);
    });
});
