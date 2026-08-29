// LSP 配置：server 配置类型 + 加载默认配置 + 用户配置
//
// 配置来源（优先级从高到低）：
// 1. .pillar/lsp.json              ← 项目级（团队共享）
// 2. ~/.pillar/lsp.json            ← 用户级（个人偏好）
// 3. 内置默认配置                  ← pyright + typescript-language-server
//
// 配置格式（参考 claude-code .lsp.json）：
// {
//   "pyright": {
//     "command": "pyright-langserver",
//     "args": ["--stdio"],
//     "extensions": [".py"]
//   },
//   "typescript-language-server": {
//     "command": "typescript-language-server",
//     "args": ["--stdio"],
//     "extensions": [".ts", ".tsx", ".mts", ".cts"]
//   }
// }

import {existsSync, readFileSync} from "fs";
import {join} from "path";
import {homedir} from "os";
import {createRequire} from "module";
import {fileURLToPath} from "url";

const require = createRequire(import.meta.url);

export interface LspServerConfig {
    // 启动命令（如 "pyright-langserver"）
    command: string;
    // 命令参数（如 ["--stdio"]）
    args?: string[];
    // 此 server 处理的文件后缀（如 [".py", ".pyi"]）
    extensions: string[];
    // 工作区目录（默认用 cwd）
    workspaceFolder?: string;
}

export type LspConfig = Record<string, LspServerConfig>;

// 内置默认配置：pyright + typescript-language-server
// 这两个都是 npm 包，不需要用户系统安装
function builtinConfig(): LspConfig {
    // pyright 和 typescript-language-server 都是 npm 包，用 require.resolve 找入口
    const pyrightPath = safeResolve("pyright/langserver.index.js");
    const tsLspPath = safeResolve("typescript-language-server/lib/cli.mjs");
    const nodeCommand = process.env.NODE_BINARY || "node";
    const userInfoPatch = fileURLToPath(new URL("./userInfoPatch.cjs", import.meta.url));

    const config: LspConfig = {};

    if (pyrightPath) {
        config.pyright = {
            command: nodeCommand,
            args: ["--require", userInfoPatch, pyrightPath, "--stdio"],
            extensions: [".py", ".pyi"],
        };
    }

    if (tsLspPath) {
        config["typescript-language-server"] = {
            command: nodeCommand,
            args: ["--require", userInfoPatch, tsLspPath, "--stdio"],
            extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        };
    }

    return config;
}

// 安全的 require.resolve（失败返回 undefined）
function safeResolve(specifier: string): string | undefined {
    try {
        return require.resolve(specifier);
    } catch {
        return undefined;
    }
}

// 加载用户/项目配置文件
function loadConfigFile(path: string): LspConfig {
    try {
        if (!existsSync(path)) return {};
        const content = readFileSync(path, "utf-8");
        return JSON.parse(content) as LspConfig;
    } catch {
        return {};
    }
}

// 加载所有配置：默认 + 用户 + 项目（后者覆盖前者同名 server）
export function loadLspConfig(cwd: string): LspConfig {
    const userConfig = loadConfigFile(join(homedir(), ".pillar", "lsp.json"));
    const projectConfig = loadConfigFile(join(cwd, ".pillar", "lsp.json"));

    // 过滤掉 undefined 值（JSON.parse 可能产生）
    const filterValid = (cfg: LspConfig): LspConfig => {
        const result: LspConfig = {};
        for (const [k, v] of Object.entries(cfg)) {
            if (v) result[k] = v;
        }
        return result;
    };

    return {
        ...filterValid(builtinConfig()),
        ...filterValid(userConfig),
        ...filterValid(projectConfig),
    };
}
