import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {MACOS_CLIPBOARD_IMAGE_SCRIPT} from "./clipboardScript.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

const resultSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("image"), data: z.string().min(1).max(4 * Math.ceil(20 * 1024 * 1024 / 3))}).strict(),
    z.object({kind: z.literal("empty")}).strict(), z.object({kind: z.literal("error")}).strict(),
]);

/** User-triggered CLI input only. Never invoked by a model tool or ordinary text paste. */
export async function readClipboardImage(signal: AbortSignal): Promise<Buffer> {
    throwIfTurnAborted(signal);
    if (process.platform !== "darwin") throw new Error("图片剪贴板目前仅支持本机 macOS；请用 /attach 本地图片路径");
    let output: string;
    try {
        const result = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", MACOS_CLIPBOARD_IMAGE_SCRIPT], {
            signal, timeout: 5000, maxBuffer: 28 * 1024 * 1024, encoding: "utf8", env: {PATH: "/usr/bin:/bin"},
        });
        output = result.stdout;
    } catch {
        throwIfTurnAborted(signal);
        throw new Error("无法读取本机图片剪贴板（系统限制、超时或内容过大）；请保存图片后用 /attach 添加");
    }
    throwIfTurnAborted(signal);
    return parseClipboardImage(output);
}

export function parseClipboardImage(output: string): Buffer {
    if (output.length > 28 * 1024 * 1024) throw new Error("图片剪贴板结果过大");
    let raw: unknown;
    try {raw = JSON.parse(output);} catch {throw new Error("图片剪贴板返回了无效结果");}
    const result = resultSchema.safeParse(raw);
    if (!result.success) throw new Error("图片剪贴板返回了无效结果");
    if (result.data.kind === "empty") throw new Error("剪贴板中没有 PNG/TIFF 图片；复制文件路径或文本请用 /attach");
    if (result.data.kind === "error") throw new Error("剪贴板不可用、图片过大、不可解码或读取时发生变化；请重新复制后再试");
    const data = Buffer.from(result.data.data, "base64");
    if (data.length > 20 * 1024 * 1024 || data.toString("base64") !== result.data.data) throw new Error("图片剪贴板数据无效");
    return data;
}
