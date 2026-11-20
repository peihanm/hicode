import {quote} from "@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js";

/** Decode only the pinned ASRT quote() output, never arbitrary shell syntax. */
function wrapperArguments(command: string): string[] {
    const token = /[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*|'(?:[^']|'"'"')*'/gy;
    const args: string[] = [];
    let offset = 0;
    while (offset < command.length) {
        token.lastIndex = offset;
        const match = token.exec(command);
        if (!match) throw new Error("Unsupported ASRT macOS wrapper format");
        const value = match[0];
        args.push(value.startsWith("'") ? value.slice(1, -1).replaceAll("'\"'\"'", "'") : value);
        offset = token.lastIndex;
        if (offset < command.length && command[offset++] !== " ") throw new Error("Unsupported ASRT macOS wrapper separator");
    }
    if (quote(args) !== command) throw new Error("ASRT macOS wrapper did not round-trip safely");
    return args;
}

/** ASRT 0.0.66's open mode allows network*, including host Unix services. */
export function macOSSandboxArgv(wrappedCommand: string, command: string, allowedSockets: readonly string[]): string[] {
    const args = wrapperArguments(wrappedCommand);
    const index = args.indexOf("/usr/bin/sandbox-exec");
    const profile = args[index + 2];
    if (args[0] !== "env" || index < 1 || args[index + 1] !== "-p" ||
        !profile?.startsWith("(version 1)") || args.length !== index + 6 ||
        args[index + 4] !== "-c" || args[index + 5] !== command) {
        throw new Error("ASRT macOS wrapper is missing the expected sandbox profile");
    }
    // Keep the upstream file/process policy intact. Apply a final, narrower
    // denial in the same profile: macOS cannot safely nest sandbox-exec.
    const exceptions = allowedSockets.map(path => `(literal ${JSON.stringify(path)})`).join(" ");
    const remote = exceptions ? `(require-all (remote unix-socket) (require-not (remote unix-socket ${exceptions})))` : "(remote unix-socket)";
    const local = exceptions ? `(require-all (local unix-socket) (require-not (local unix-socket ${exceptions})))` : "(local unix-socket)";
    args[index + 2] = `${profile}\n(deny network-outbound ${remote})\n(deny network-bind ${local})`;
    args[0] = "/usr/bin/env";
    return args;
}
