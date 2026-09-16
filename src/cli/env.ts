import {hasFileSystemErrorCode} from "../persistence/index.js";
import {config as dotenvConfig} from "dotenv";
import {join} from "node:path";
import {getUserCredentialsPath, type HiCodeStorageLayout} from "../persistence/layout.js";

/** Process values win; project values are loaded first, user values fill missing entries. */
export function loadEnv(storage: HiCodeStorageLayout, cwd: string): void {
    for (const path of [join(cwd, ".env"), getUserCredentialsPath(storage)]) {
        const result = dotenvConfig({path, quiet: true});
        if (result.error && !hasFileSystemErrorCode(result.error, "ENOENT")) {
            throw new Error(`Cannot read credential file: ${path}`);
        }
    }
}
