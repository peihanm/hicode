import {release, type} from "node:os";
import {bashExecutable} from "../tools/bash/command.js";

export interface EnvInfo {
    cwd: string;
    platform: string;
    shell: string;
    model: string;
}

/** Build the stable host facts used by the system prompt without doing I/O. */
export function detectEnv(cwd: string, model: string): EnvInfo {
    return {
        cwd,
        platform: `${type()} ${release()}`,
        shell: bashExecutable(),
        model,
    };
}
