import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {config as dotenvConfig} from "dotenv";

// Explicit .env discovery: cwd first, then ~/.pillar/.env as the user-level fallback.
// Do not use dotenv/config defaults, which only inspect cwd; a globally launched CLI
// may start outside the project root and miss configuration.
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

    console.error("\x1b[31mNo .env configuration file found.\x1b[0m");
    console.error(`  Tried: ${cwdEnv}`);
    console.error(`           ${globalEnv}`);
    console.error("Place .env in the working directory or configure a global API key in ~/.pillar/.env.");
    process.exit(1);
}
