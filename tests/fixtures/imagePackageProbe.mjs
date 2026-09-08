// Executed from an isolated packed consumer under both Node and Bun.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import sharp from "sharp";

export async function runImageProbe(screenshotPath) {
    const started = performance.now();
    const checks = [];
    const options = {limitInputPixels: 40_000_000, failOn: "warning"};
    const source = await sharp({create: {
        width: 96, height: 48, channels: 4, background: {r: 20, g: 80, b: 160, alpha: 0.5},
    }}).png().toBuffer();

    // Decode pixels, not just a header that may still be readable in a corrupt file.
    for (const format of ["png", "jpeg", "webp"]) {
        const input = await sharp(source).toFormat(format).toBuffer();
        const {data, info} = await sharp(input, options).png().toBuffer({resolveWithObject: true});
        assert.equal(info.width, 96);
        assert.equal(info.height, 48);
        assert.equal((await sharp(data).metadata()).format, "png");
    }
    checks.push("png/jpeg/webp decode and normalize");

    const alpha = await sharp(source, options).png().raw().toBuffer({resolveWithObject: true});
    assert.equal(alpha.info.channels, 4);
    assert.ok(Math.abs(alpha.data[3] - 128) <= 1);
    checks.push("transparency preserved");

    const oriented = await sharp(source).jpeg().withMetadata({orientation: 6}).toBuffer();
    const rotated = await sharp(oriented, options).autoOrient().png().toBuffer();
    const rotatedMeta = await sharp(rotated).metadata();
    assert.equal(rotatedMeta.width, 48);
    assert.equal(rotatedMeta.height, 96);
    assert.equal(rotatedMeta.orientation, undefined);
    assert.equal(rotatedMeta.exif, undefined);
    checks.push("EXIF orientation applied and metadata stripped");

    const wide = await sharp({create: {width: 4096, height: 32, channels: 3, background: "red"}}).png().toBuffer();
    const resized = await sharp(wide, options).resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true}).png().toBuffer({resolveWithObject: true});
    assert.equal(resized.info.width, 2048);
    assert.equal(resized.info.height, 16);
    const small = await sharp(source, options).resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true}).png().toBuffer({resolveWithObject: true});
    assert.equal(small.info.width, 96);
    checks.push("aspect ratio, max edge, no upscaling");

    await assert.rejects(sharp(Buffer.from("not an image"), options).png().toBuffer());
    await assert.rejects(sharp(source.subarray(0, Math.floor(source.length / 2)), options).png().toBuffer());
    checks.push("invalid and truncated input rejected");

    await assert.rejects(sharp(source, {...options, limitInputPixels: 100}).png().toBuffer(), /pixel limit/i);
    checks.push("decoder pixel limit enforced");

    const animation = await sharp({create: {
        width: 8, height: 16, channels: 3, background: "red", pageHeight: 8,
    }}).composite([{input: {create: {width: 8, height: 8, channels: 3, background: "blue"}}, top: 8, left: 0}]).gif({loop: 0, delay: [100, 100]}).toBuffer();
    const animatedMeta = await sharp(animation, {...options, animated: true}).metadata();
    assert.equal(animatedMeta.pages, 2);
    const firstFrame = await sharp(animation, {...options, page: 0, pages: 1}).png().toBuffer({resolveWithObject: true});
    assert.equal(firstFrame.info.width, 8);
    assert.equal(firstFrame.info.height, 8);
    checks.push("animated GIF detected, explicit first frame selection");

    // Filenames and user-declared MIME are insufficient; use actual decoded format.
    assert.equal((await sharp(source, options).metadata()).format, "png");
    const svg = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), options).metadata();
    assert.equal(svg.format, "svg");
    assert.equal(["png", "jpeg", "webp", "gif"].includes(svg.format), false);
    checks.push("format sniffing supports raster allowlist; SVG requires rejection");

    const bytes = await sharp(source, options).png().toBuffer();
    const decoded = await sharp(source).raw().toBuffer();
    assert.deepEqual(await sharp(bytes).raw().toBuffer(), decoded);
    checks.push("lossless PNG pixel roundtrip");

    let screenshot;
    if (screenshotPath) {
        const input = await readFile(screenshotPath);
        const before = await sharp(input, options).metadata();
        const normalized = await sharp(input, options).autoOrient().resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true}).png().toBuffer();
        assert.deepEqual(await sharp(normalized).raw().toBuffer(), await sharp(input).raw().toBuffer());
        screenshot = {width: before.width, height: before.height, inputBytes: input.length, outputBytes: normalized.length};
        checks.push("user screenshot lossless pixel agreement");
    }
    return {
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
        platform: `${process.platform}/${process.arch}`, sharp: sharp.versions.sharp, vips: sharp.versions.vips,
        passed: checks.length, checks, screenshot, durationMs: Math.round(performance.now() - started),
    };
}
