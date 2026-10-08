import { z } from 'zod';
import { join } from 'node:path';
import { readdir, realpath, lstat, readFile } from 'node:fs/promises';
import { readJson, evidenceTree, contained } from './store.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const sweTaskSchema = z.object({
  kind: z.literal('swe-bench-verified'), instanceId: z.string().regex(/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+-\d+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/), repo: z.enum(['django/django', 'sympy/sympy', 'pytest-dev/pytest', 'pydata/xarray', 'sphinx-doc/sphinx', 'astropy/astropy', 'scikit-learn/scikit-learn', 'pylint-dev/pylint', 'psf/requests', 'pallets/flask', 'mwaskom/seaborn', 'matplotlib/matplotlib']),
  version: z.enum(['0.12', '0.20', '0.21', '0.22', '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12', '2.0', '2.3', '2.4', '2.9', '2.10', '2.14', '2.15', '2.26', '2.27', '3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.3', '4.5', '4.6', '7.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2', '5.4', '6.0', '6.2', '6.3', '7.2', '2022.03', '2022.06', '2022.09']),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), harnessVersion: z.literal('4.1.0'),
  environment: z.string().regex(/^\/opt\/hicode-swe\/cache\/[a-f0-9]{64}$/),
  python: z.enum(['3.6', '3.7', '3.8', '3.9', '3.10', '3.11']), verifierSeconds: z.number().int().min(60).max(7200),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(sha), evaluationMode: z.literal('shared-linux-development'),
}).strict();
export type SweTask = z.infer<typeof sweTaskSchema>;
function checkPythonVersion(task: SweTask): void {
  const expected = task.repo === 'django/django'
    ? ['3.0', '3.1', '3.2'].includes(task.version) ? '3.6'
      : task.version === '4.0' ? '3.8'
      : task.version === '4.1' || task.version === '4.2' ? '3.9'
      : task.version === '5.0' ? '3.11' : undefined
    : task.repo === 'sympy/sympy'
      ? ['1.0', '1.1', '1.2', '1.4', '1.5', '1.6'].includes(task.version) ? '3.6'
        : ['1.7', '1.8', '1.9', '1.10', '1.11', '1.12'].includes(task.version) ? '3.9' : undefined
      : task.repo === 'pytest-dev/pytest'
        ? ['4.5', '4.6', '5.0', '5.1', '5.2', '5.4', '6.0', '6.2', '6.3', '7.2'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'sphinx-doc/sphinx'
          ? ['3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '4.0', '4.1', '4.2', '4.3', '5.0', '5.1', '5.2', '7.1', '7.2'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'astropy/astropy' ? task.version === '1.3' ? '3.6'
          : ['3.1', '4.3', '5.0', '5.1', '5.2'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'scikit-learn/scikit-learn' ? ['0.20','0.21','0.22'].includes(task.version) ? '3.6'
          : task.version === '1.3' ? '3.9' : undefined
        : task.repo === 'pylint-dev/pylint' ? ['2.9', '2.10', '2.14', '2.15', '3.0'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'psf/requests' ? ['1.1', '2.0', '2.3', '2.4', '2.9', '2.26', '2.27'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'pallets/flask' ? task.version === '2.3' ? '3.11' : undefined
        : task.repo === 'matplotlib/matplotlib' ? task.version === '3.0' ? '3.7'
          : ['3.1','3.2','3.3','3.4'].includes(task.version) ? '3.8'
          : ['3.5','3.6','3.7'].includes(task.version) ? '3.11' : undefined
        : task.repo === 'mwaskom/seaborn' ? task.version === '0.12' ? '3.9' : undefined
        : ['0.12', '2022.03', '2022.06', '2022.09'].includes(task.version) ? '3.10' : undefined;
  if (!expected || task.python !== expected ||
      !task.instanceId.startsWith(task.repo.replace('/', '__') + '-'))
    throw Error('SWE task identity differs from the supported repository environment');
}
export async function sweTree(path: string) {
  const files = await evidenceTree(path);
  for(const [name,file] of Object.entries(files)) {
    if(file.symlink !== undefined && (!name.startsWith('repository/') || !contained(join(path,'repository'),await realpath(join(path,name))))) throw Error('SWE source link escapes its repository');
    // Git tracks link identity and executable bits, not host symlink permissions.
    // macOS cp creates links under the CLI's private umask; Linux ignores these bits.
    Object.assign(file,{mode:file.symlink !== undefined ? 0o120000 :
      ((await lstat(join(path,name))).mode & 0o111 ? 0o100755 : 0o100644)});
  }
  return files;
}
export async function validateFrozenSweTask(id: string, path: string): Promise<SweTask> {
  const task = await readJson(join(path, 'swe-task.json'), sweTaskSchema);
  if (task.instanceId !== id) throw Error('SWE task identity mismatch');
  checkPythonVersion(task);
  const actual = await sweTree(path);
  delete actual['swe-task.json'];
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(task.files).sort()) ||
    Object.entries(actual).some(([name, file]) => task.files[name] !== file.sha256)) throw Error('SWE task differs from its prepared snapshot');
  // Frozen bundle separates inputs from host-only grading material; no gold patch is stored.
  if (!task.files['instruction.md'] || !task.files['hidden/evaluation.json'] || !Object.keys(task.files).some(p => p.startsWith('repository/'))) throw Error('Incomplete SWE bundle');
  return task;
}
export async function validateSweTask(id: string, path: string): Promise<SweTask> {
  const task = await validateFrozenSweTask(id,path);
  // Empty directories are absent from file hashes, but bubblewrap cannot create
  // a missing hooks mount point after the parent .git is made read-only.
  for (const name of ['.git', '.git/hooks']) {
    const info = await lstat(join(path,'repository',name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw Error(`SWE source requires a real repository/${name} directory before registration or submission; prepare the Git workspace and run the Actor sandbox preflight`);
    }
  }
  if (task.repo === 'astropy/astropy' && ['1.3','3.1'].includes(task.version)) {
    const declaration=join(path,task.version==='1.3'?'repository/setup.py':'repository/setup.cfg');
    const stat=await lstat(declaration);
    const marker=task.version==='1.3'?/^VERSION = '3\.1\.dev'$/m:/^version = 4\.0\.dev$/m;
    if(!stat.isFile()||stat.isSymbolicLink()||!marker.test(await readFile(declaration,'utf8')))
      throw Error('Astropy source lacks its reviewed static version');
  }
  if (task.repo === 'pytest-dev/pytest' || task.repo === 'pydata/xarray' ||
      (task.repo === 'astropy/astropy' && !['1.3','3.1'].includes(task.version)) || task.repo === 'matplotlib/matplotlib') {
    await readJson(join(path,'repository/.git/hicode-source-version.json'),z.object({
      baseCommit:z.literal(task.baseCommit),
      describe:z.string().regex(/^v?[0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev\d*)?-\d+-g[a-f0-9]+$/),
      version:z.string().regex(/^[0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev[0-9]+\+g[a-f0-9]+|\+[0-9]+\.g[a-f0-9]+)?$/),
    }).strict());
  }
  if (task.repo === 'pydata/xarray') {
    await readJson(join(path,'repository/.git/hicode-env-preflight.json'), z.object({
      sourceCommit:z.literal(task.baseCommit),environment:z.literal(task.environment),
      passed:z.literal(true),checked:z.number().int().positive(),
    }).strict());
  }
  return task;
}
export async function sweCatalog(root?: string) {
  if (!root) return [];
  const result = [];
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const task = await readJson(join(root, entry.name, 'swe-task.json'), sweTaskSchema);
    if (task.instanceId !== entry.name) throw Error('SWE directory identity mismatch');
    checkPythonVersion(task);
    result.push({id:task.instanceId,category:'SWE-bench Verified',seconds:1800,dataset:'swe-bench-verified' as const});
  }
  return result;
}
