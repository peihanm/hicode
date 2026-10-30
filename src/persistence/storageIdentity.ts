import {sessionStorageId, type SessionStorageOwner} from "./layout.js";
import {z} from "zod";
import {basename, dirname} from "node:path";
import {realpath} from "node:fs/promises";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile} from "./privateStorage.js";
import {withFileLock} from "./fileLock.js";
import {writeFileAtomically} from "./atomicFile.js";
import {getProjectIdentityLockPath, getProjectIdentityPath, getSessionIdentityPath} from "./layout.js";
import type {HiCodeStorageLayout} from "./layout.js";

const MAX_IDENTITY_BYTES = 32 * 1024;

const projectIdentitySchema = z.object({
    version: z.literal(1),
    cwd: z.string(),
    name: z.string(),
    createdAt: z.string().datetime(),
}).strict();

const sessionIdentitySchema = z.object({
    version: z.literal(1),
    cwd: z.string(),
    sessionId: z.string(),
    createdAt: z.string().datetime(),
}).strict();

export async function ensureSessionIdentity(
    storage: HiCodeStorageLayout,
    cwd: string,
    sessionId: SessionStorageOwner
): Promise<void> {
    const path = getSessionIdentityPath(storage, cwd, sessionId);
    ensurePrivateStorageDirectory(storage, dirname(path));
    const previous = readPrivateStorageTextFile(storage, path, MAX_IDENTITY_BYTES);
    if (previous !== null) {
        const stored = sessionIdentitySchema.parse(JSON.parse(previous));
        if (stored.sessionId !== sessionStorageId(sessionId) || stored.cwd !== cwd) {
            throw new Error("Session identity changed");
        }
        return;
    }
    await writeFileAtomically(path, JSON.stringify({
        version: 1, cwd, sessionId: sessionStorageId(sessionId), createdAt: new Date().toISOString(),
    }, null, 2), 0o600);
}

export async function ensureProjectIdentity(storage: HiCodeStorageLayout, cwd: string): Promise<void> {
    const canonical = await realpath(cwd);
    const path = getProjectIdentityPath(storage, cwd);
    ensurePrivateStorageDirectory(storage, dirname(path));
    await withFileLock(getProjectIdentityLockPath(storage, cwd), async () => {
        const previous = readPrivateStorageTextFile(storage, path, MAX_IDENTITY_BYTES);
        if (previous !== null) {
            const stored = projectIdentitySchema.parse(JSON.parse(previous));
            if (stored.cwd !== canonical) throw new Error("Project identity changed");
            return;
        }
        await writeFileAtomically(path, JSON.stringify({
            version: 1, cwd: canonical, name: basename(canonical), createdAt: new Date().toISOString(),
        }, null, 2), 0o600);
    });
}
