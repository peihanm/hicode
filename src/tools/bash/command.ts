import {existsSync} from "node:fs";
import {win32} from "node:path";

/** Both direct execution and the Sandbox backend launch the same Bash dialect. */
export function bashExecutable(): string {
    if (process.platform !== "win32") return "/bin/bash";
    const directories = [
        ...(process.env.PATH ?? "").split(";"),
        ...(process.env.ProgramFiles ? [win32.join(process.env.ProgramFiles, "Git", "bin")] : []),
    ];
    for (const directory of directories) {
        if (!win32.isAbsolute(directory)) continue;
        const candidate = win32.join(directory, "bash.exe");
        // System32's WSL launcher does not implement the native Bash contract.
        if (!candidate.toLowerCase().includes("\\windows\\system32\\") && existsSync(candidate)) return candidate;
    }
    throw new Error("Bash 执行需要原生 bash.exe（例如 Git Bash）；未找到，不回退到 cmd.exe。");
}

export function bashCommand(command: string): string {
    // No errexit: explicit || and the caller's command-list status remain intact.
    return `set -o pipefail\n${command}`;
}
