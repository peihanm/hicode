import {formatHeadlessOutput} from "./output.js";
import type {HeadlessOutputFormat, HeadlessRunSummary} from "./types.js";

function writeStream(stream: NodeJS.WritableStream, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.write(text, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

export async function writeHeadlessStdout(text: string): Promise<void> {
    await writeStream(process.stdout, text.endsWith("\n") ? text : `${text}\n`);
}

export async function writeHeadlessOutput(
    summary: HeadlessRunSummary,
    format: HeadlessOutputFormat
): Promise<void> {
    await writeHeadlessStdout(formatHeadlessOutput(summary, format));
}

export function writeHeadlessDiagnostic(line: string): void {
    console.error(line);
}
