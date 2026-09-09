import {expect, test} from "bun:test";
import {pastedImagePath} from "../../src/ui/input/pastedImage.js";

test("whole local image paths accept file drops, quotes and local file URLs", () => {
    expect(pastedImagePath("/Users/test/image.png")).toBe("/Users/test/image.png");
    expect(pastedImagePath(" '/tmp/中文 图片.PNG' ")).toBe("/tmp/中文 图片.PNG");
    expect(pastedImagePath('"/tmp/中文 图片.jpeg"')).toBe("/tmp/中文 图片.jpeg");
    expect(pastedImagePath("/tmp/a\\ b\\(1\\).webp ")).toBe("/tmp/a b(1).webp");
    expect(pastedImagePath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
    expect(pastedImagePath("./images/a.jpg")).toBe("./images/a.jpg");
    expect(pastedImagePath("../images/a.jpg")).toBe("../images/a.jpg");
});

test("prose, commands, remote URLs and ambiguous path lists stay text", () => {
    for (const text of ["看一下 /tmp/a.png", "cat /tmp/a.png", "/attach /tmp/a.png", "https://example.com/a.png",
        "file://remote/tmp/a.png", "file:///tmp/a.png?secret=x", "file:///tmp/a.png#part", "/tmp/a.gif",
        "/tmp/a.svg", "'/tmp/a.png", "/tmp/a.png\n/tmp/b.png", "/tmp/a.png /tmp/b.png", "/tmp/$(pwd).png",
        "file:///tmp/a%00.png", "/tmp/\u001b[31ma.png", "/" + "a".repeat(4096) + ".png"]) {
        expect(pastedImagePath(text)).toBeUndefined();
    }
});
