import {fileURLToPath} from "node:url";

/** Recognize a whole path insertion, never extract filenames from prose or commands. */
export function pastedImagePath(text: string): string | undefined {
    if (text.length > 4096) return undefined;
    let path = text.trim();
    if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
    const quote = path[0];
    if (quote === "'" || quote === '"') {
        if (!path.endsWith(quote)) return undefined;
        path = path.slice(1, -1);
    } else {
        // Terminal file drops commonly escape spaces and punctuation with a backslash.
        path = path.replace(/\\([ ()\[\]'"&])/g, "$1");
    }
    if (path.startsWith("file://")) {
        try {
            const url = new URL(path);
            if (url.search || url.hash || (url.hostname && url.hostname !== "localhost")) return undefined;
            path = fileURLToPath(url);
        } catch {return undefined;}
    }
    if (!/^(?:\/|\.\.?\/)/.test(path) || /[\u0000-\u001f\u007f\\`$|;<>]/.test(path)) return undefined;
    if (/\s\//.test(path) || !/\.(?:png|jpe?g|webp)$/i.test(path)) return undefined;
    return path;
}
