// grep 工具的辅助函数
import {readdir, stat} from "node:fs/promises";
import {basename, join} from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

// 递归收集文件，跳过 node_modules / .git / dist
export async function walk(
    dir: string,
    glob: string | undefined,
    out: string[],
    includeHidden = false
): Promise<void> {
    // path 可能是文件不是目录，直接加入（readdir 文件会失败）
    const s = await stat(dir).catch(() => null);
    if (s?.isFile()) {
        if (!glob || matchGlob(basename(dir), glob)) out.push(dir);
        return;
    }

    let entries;
    try {
        entries = await readdir(dir, {withFileTypes: true});
    } catch {
        return;
    }

    for (const e of entries) {
        if (!includeHidden && e.name.startsWith(".")) continue; // 默认跳隐藏文件
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            await walk(full, glob, out, includeHidden);
        } else if (e.isFile()) {
            if (glob && !matchGlob(e.name, glob)) continue;
            out.push(full);
        }
    }
}

// 简单 glob 匹配：支持 * 和后缀（如 *.ts）
function matchSingleGlob(name: string, glob: string): boolean {
    if (!glob.includes("*")) return name === glob;
    const regex = new RegExp(
        "^" + glob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );
    return regex.test(name);
}

// 支持逗号分隔多个 glob，如 "*.ts,*.tsx"
function matchGlob(name: string, glob: string): boolean {
    return glob.split(",").some((g) => matchSingleGlob(name, g.trim()));
}
