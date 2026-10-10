import { constants } from 'node:fs';
import { open, mkdir, rename, lstat, readdir, realpath, rm, readlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export async function readJson<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, max = 4 * 1024 * 1024): Promise<T> {
  if (await realpath(dirname(path)) !== resolve(dirname(path))) throw Error('Symlinked storage parent');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > max) throw Error('Invalid JSON file size/type');
    return schema.parse(JSON.parse(await fd.readFile('utf8')));
  } finally { await fd.close(); }
}
export async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(path)) !== resolve(dirname(path))) throw Error('Symlinked storage parent');
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(tmp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); }
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
export function contained(root: string, path: string): boolean {
  const p = relative(root, path); return p === '' || (!p.startsWith('..') && !isAbsolute(p));
}
export async function directory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw Error('Directory must use its canonical path');
  return canonical;
}
export async function tree(root: string): Promise<Record<string, { bytes: number; sha256: string }>> {
  return scanTree(root);
}

/** Evidence links are recorded as data and never followed, unlike immutable source inputs. */
export async function evidenceTree(root: string): Promise<Record<string, { bytes: number; sha256: string; symlink?: string }>> {
  return scanTree(root, true, 100000);
}

/** Completed attempts include generated data and compiled artifacts, unlike frozen source bundles. */
export async function runEvidenceTree(root: string): Promise<Record<string, { bytes: number; sha256: string; symlink?: string }>> {
  return scanTree(root, true, 100000, 8 * 1024 ** 3);
}

async function scanTree(root: string, recordLinks = false, maxFiles = 20000, maxBytes = 1024 ** 3): Promise<Record<string, { bytes: number; sha256: string; symlink?: string }>> {
  const result: Record<string, { bytes: number; sha256: string; symlink?: string }> = {};
  let bytes = 0, fileCount = 0;
  async function walk(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      if (!recordLinks) throw Error('Symlinks are not allowed in source snapshots');
      const target = await readlink(path);
      if (Buffer.byteLength(target) > 4096 || target.includes('\0')) throw Error('Invalid evidence link');
      result[relative(root, path)] = {bytes: Buffer.byteLength(target), sha256: createHash('sha256').update(target).digest('hex'), symlink: target};
      if (++fileCount > maxFiles) throw Error('Snapshot budget exceeded');
      return;
    }
    if (stat.isDirectory()) { for (const name of (await readdir(path)).sort()) await walk(join(path, name)); }
    else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > maxBytes || ++fileCount > maxFiles) throw Error('Snapshot budget exceeded');
      const hash = createHash('sha256');
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const buffer = Buffer.alloc(65536); for (;;) { const { bytesRead } = await fd.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } } finally { await fd.close(); }
      result[relative(root, path)] = { bytes: stat.size, sha256: hash.digest('hex') };
    } else throw Error('Only regular files may be collected');
  }
  await walk(root); return result;
}
export async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number; includeStderr?: boolean; signal?:AbortSignal } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const proc = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' });
  const abort=()=>{proc.kill('SIGKILL');};
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)abort();
  const timeout = options.timeout ?? 30000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    options.signal?.throwIfAborted();
    if (timedOut) throw Error(`${command[0]} timed out after ${timeout}ms`);
    if (code) throw Error(`${command[0]} failed (exit ${code}): ${stderr.slice(options.includeStderr ? -32768 : -1000)}`);
    const output=options.includeStderr?stdout+'\n'+stderr:stdout;
    if (output.length > 4 * 1024 * 1024) throw Error('Command output exceeds budget');
    return output.trim();
  } finally { clearTimeout(timer);options.signal?.removeEventListener('abort',abort); }
}
