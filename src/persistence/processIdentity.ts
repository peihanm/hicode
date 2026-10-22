import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {readFile, readlink} from "node:fs/promises";
import {promisify} from "node:util";
interface ProcessIdentity {
    pid: number;
    environment: string;
    start: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);

async function systemOutput(command: string, args: string[]): Promise<string> {
    const result = await execute(command, args, {timeout: 1000, maxBuffer: 4096,
        env: {PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC"}});
    return result.stdout.trim();
}

async function environmentIdentity(): Promise<string> {
    if (process.platform === "linux") {
        const [boot, namespace] = await Promise.all([
            readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"),
        ]);
        if (!/^[a-f0-9-]{36}$/i.test(boot.trim()) || !/^pid:\[\d+\]$/.test(namespace)) throw new Error("Invalid Linux process environment");
        return digest(`linux:${boot.trim()}:${namespace}`);
    }
    if (process.platform === "darwin") {
        const boot = await systemOutput("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
        if (!/^[a-f0-9-]{36}$/i.test(boot)) throw new Error("Invalid macOS boot identity");
        return digest(`darwin:${boot}`);
    }
    throw new Error("Persistent process ownership requires macOS or Linux");
}

async function startIdentity(pid: number): Promise<string | undefined> {
    try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "")) throw new Error("Invalid Linux process identity");
            if (fields[0] === "Z" || fields[0] === "X") return undefined;
            return digest(fields[19]!);
        }
        const fields = (await systemOutput("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="])).split(/\s+/);
        const state = fields.pop();
        const start = fields.join(" ");
        if (!state || !/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)) throw new Error("Invalid macOS process identity");
        if (state.startsWith("Z")) return undefined;
        return digest(start);
    } catch (error) {
        // An inaccessible process is not proof that its lease is abandoned.
        try {process.kill(pid, 0);} catch (probe) {
            if (probe instanceof Error && "code" in probe && probe.code === "ESRCH") return undefined;
        }
        throw error;
    }
}

export async function captureProcessIdentity(): Promise<ProcessIdentity> {
    const environment = await environmentIdentity();
    const start = await startIdentity(process.pid);
    if (!start) throw new Error("Cannot identify the current process");
    return {pid: process.pid, environment, start};
}

/** Never interpret a PID in another boot/namespace as the recorded owner. */
export async function processOwnerState(owner: ProcessIdentity, local: ProcessIdentity): Promise<"alive" | "dead" | "unknown"> {
    if (owner.environment !== local.environment) return "unknown";
    try {
        const start = await startIdentity(owner.pid);
        return start === owner.start ? "alive" : "dead";
    } catch {return "unknown";}
}
