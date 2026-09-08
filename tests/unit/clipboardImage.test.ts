import {expect, test} from "bun:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import sharp from "sharp";
import {parseClipboardImage, readClipboardImage} from "../../src/cli/clipboard.js";
import {MACOS_CLIPBOARD_IMAGE_SCRIPT} from "../../src/cli/clipboardScript.js";

test("clipboard adapter validates bounded output and reports empty, changed and malformed data without echo", async () => {
    const data = Buffer.from("fixture");
    expect(parseClipboardImage(JSON.stringify({kind: "image", data: data.toString("base64")}))).toEqual(data);
    for (const raw of ["broken", '{"kind":"empty"}', '{"kind":"error"}', '{"kind":"image","data":"secret!"}', '{"kind":"image","data":""}', '{"kind":"image","data":"aaaa","path":"/etc/passwd"}']) {
        try {parseClipboardImage(raw); throw new Error("accepted invalid clipboard result");}
        catch (error) {expect(String(error)).not.toContain("secret!"); expect(String(error)).not.toContain("accepted invalid");}
    }
    await expect(readClipboardImage(AbortSignal.abort())).rejects.toThrow();
});

// Opt-in: native pasteboard needs a macOS window server. Never reads/writes the user's general clipboard.
test.skipIf(process.platform !== "darwin" || process.env.PILLAR_TEST_CLIPBOARD_NATIVE !== "1")("native macOS adapter reads PNG/TIFF from private pasteboards without touching the user clipboard", async () => {
    const raw = await sharp({create: {width: 20, height: 12, channels: 4, background: {r: 90, g: 40, b: 200, alpha: 0.5}}}).png().toBuffer();
    for (const format of ["png", "tiff", "text"] as const) {
        const bytes = format === "text" ? Buffer.from("private fixture text") : format === "tiff" ? await sharp(raw).tiff({compression: "lzw"}).toBuffer() : raw;
        const type = format === "text" ? "public.utf8-plain-text" : `public.${format}`;
        const isolated = "let testBoard;\n" + MACOS_CLIPBOARD_IMAGE_SCRIPT.replace("function run()", "function readFixtureClipboard()").replace("$.NSPasteboard.generalPasteboard", `(() => {
            const board = $.NSPasteboard.pasteboardWithUniqueName;
            testBoard = board;
            board.clearContents;
            const bytes = $.NSData.alloc.initWithBase64EncodedStringOptions('${bytes.toString("base64")}', 0);
            board.setDataForType(bytes, '${type}');
            return board;
        })()`) + "\nfunction run() { try { return readFixtureClipboard(); } finally { if (testBoard) testBoard.releaseGlobally; } }";
        const {stdout} = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", isolated], {timeout: 5000, maxBuffer: 100000, env: {PATH: "/usr/bin:/bin"}});
        if (format === "text") expect(() => parseClipboardImage(stdout)).toThrow("没有 PNG/TIFF");
        else {
            const parsed = parseClipboardImage(stdout);
            const {data, info} = await sharp(parsed).raw().toBuffer({resolveWithObject: true});
            expect([info.width, info.height, info.channels]).toEqual([20, 12, 4]);
            expect(data[3]).toBe(128);
        }
    }
});
