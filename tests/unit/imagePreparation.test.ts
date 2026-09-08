import {expect, test} from "bun:test";
import sharp from "sharp";
import {prepareImage} from "../../src/images/prepare.js";

const active = () => new AbortController().signal;
test("decode static formats, retain alpha, orient, strip metadata and scale", async () => {
    const raw = await sharp({create: {width: 64, height: 32, channels: 4, background: {r: 255, g: 0, b: 0, alpha: 0.5}}}).png().toBuffer();
    for (const format of ["png", "jpeg", "webp"] as const) {
        const source = await sharp(raw).toFormat(format).toBuffer();
        const result = await prepareImage(source, active());
        expect([result.image.width, result.image.height]).toEqual([64, 32]);
    }
    const transparent = await prepareImage(raw, active());
    expect((await sharp(transparent.data).raw().toBuffer())[3]).toBe(128);
    const oriented = await sharp(raw).jpeg().withMetadata({orientation: 6}).toBuffer();
    const rotated = await prepareImage(oriented, active());
    expect([rotated.image.width, rotated.image.height]).toEqual([32, 64]);
    expect((await sharp(rotated.data).metadata()).exif).toBeUndefined();
    const wide = await sharp({create: {width: 4096, height: 32, channels: 3, background: "red"}}).png().toBuffer();
    const scaled = await prepareImage(wide, active());
    expect([scaled.image.width, scaled.image.height]).toEqual([2048, 16]);
});

test("reject invalid bytes, truncation, unsupported formats, animation, input bytes and pixels", async () => {
    const source = await sharp({create: {width: 32, height: 32, channels: 3, background: "red"}}).png().toBuffer();
    for (const bytes of [Buffer.from("invalid"), source.subarray(0, 50), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
        await expect(prepareImage(bytes, active())).rejects.toThrow();
    }
    await expect(prepareImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), active())).rejects.toThrow("仅支持静态");
    await expect(prepareImage(await sharp(source).gif().toBuffer(), active())).rejects.toThrow("仅支持静态");
    // acTL signals animation even when libvips reports only the PNG default frame.
    const animationControl = Buffer.alloc(20);
    animationControl.writeUInt32BE(8, 0);
    animationControl.write("acTL", 4);
    animationControl.writeUInt32BE(2, 8);
    await expect(prepareImage(Buffer.concat([source.subarray(0, 33), animationControl, source.subarray(33)]), active())).rejects.toThrow("APNG");
    const animated = await sharp({create: {width: 8, height: 16, pageHeight: 8, channels: 3, background: "red"}})
        .composite([{input: {create: {width: 8, height: 8, channels: 3, background: "blue"}}, top: 8, left: 0}]).webp({delay: [100, 100]}).toBuffer();
    await expect(prepareImage(animated, active())).rejects.toThrow("仅支持静态");
    const huge = await sharp({create: {width: 8000, height: 6000, channels: 3, background: "red"}}).png().toBuffer();
    await expect(prepareImage(huge, active())).rejects.toThrow("pixel limit");
    await expect(prepareImage(source, AbortSignal.abort("user-cancel"))).rejects.toThrow();
});

test("large lossless output is explicitly rejected; cancellation during work returns no prepared asset", async () => {
    const pixels = Buffer.alloc(1024 * 1024 * 3);
    let seed = 123456789;
    for (let i = 0; i < pixels.length; i++) {seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255;}
    const noisy = await sharp(pixels, {raw: {width: 1024, height: 1024, channels: 3}}).png().toBuffer();
    await expect(prepareImage(noisy, active())).rejects.toThrow("2 MiB");
    const controller = new AbortController();
    const pending = prepareImage(noisy, controller.signal);
    controller.abort("user-cancel");
    await expect(pending).rejects.toThrow();
});
