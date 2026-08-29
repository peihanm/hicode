import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {config as dotenvConfig} from "dotenv";

// 显式 .env 查找：先 cwd（用户项目里），再 ~/.pillar/.env（全局兜底）。
// 不用 dotenv/config 的默认行为，因为它只看 cwd；全局 CLI 启动时
// cwd 可能不是项目根，会找不到配置。
export function loadEnv(options: {required?: boolean} = {}): void {
    const cwdEnv = resolve(process.cwd(), ".env");
    const globalEnv = resolve(homedir(), ".pillar", ".env");

    if (existsSync(cwdEnv)) {
        dotenvConfig({path: cwdEnv, quiet: true});
        return;
    }
    if (existsSync(globalEnv)) {
        dotenvConfig({path: globalEnv, quiet: true});
        return;
    }

    if (options.required === false) return;

    console.error("\x1b[31m找不到 .env 配置文件。\x1b[0m");
    console.error(`  尝试过：${cwdEnv}`);
    console.error(`           ${globalEnv}`);
    console.error("请把 .env 放在当前工作目录，或在 ~/.pillar/.env 配置全局 API key。");
    process.exit(1);
}
