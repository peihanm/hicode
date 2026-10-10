import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareTaskInputs, preparePublicTestInputs, publicTaskProfile } from '../src/host/publicTasks.js';
import { tree } from '../src/host/store.js';

const content = Buffer.from([0, 255, 10, 128, 42]);
const hash = createHash('sha256').update(content).digest('hex');
const profile = { hashes: { 'environment/input.bin': hash }, inputs: [{ source: 'environment/input.bin', target: 'input.bin' }], initializer: null, directories: [], packages: [], verifierPackages: [], verifierPrelude: 'none' as const };

test('a malformed unrelated task profile cannot invalidate an active task',async()=>{
  const manifest={fixture:profile,unrelated:{...profile,hashes:{'instruction.md':'short'}}};
  expect(publicTaskProfile(manifest,'fixture').inputs).toEqual(profile.inputs);
  expect(()=>publicTaskProfile(manifest,'unrelated')).toThrow();
  expect(()=>publicTaskProfile(manifest,'missing')).toThrow('not been adapted');
});
async function fixture(run: (root: string, task: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hicode-eval-inputs-'))), task = join(root, 'task');
  try {
    await mkdir(join(task, 'environment'), { recursive: true });
    await writeFile(join(task, 'environment/input.bin'), content);
    await run(root, task);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('only declared public inputs are staged byte-for-byte, including nested destinations', async () => {
  await fixture(async (root, task) => {
    for (const name of ['tests', 'solution']) {
      await mkdir(join(task, name)); await writeFile(join(task, name, 'hidden.txt'), 'must not enter workspace');
    }
    const destination = join(root, 'inputs');
    await prepareTaskInputs(task, destination, { ...profile, inputs: [{ source: 'environment/input.bin', target: 'nested/input.bin' }] });
    expect(Object.keys(await tree(destination))).toEqual(['nested/input.bin']);
    expect(await readFile(join(destination, 'nested/input.bin'))).toEqual(content);
    expect(await readFile(join(task, 'environment/input.bin'))).toEqual(content);
  });
});

test('corrupt input and reused or symlinked staging directories are rejected', async () => {
  await fixture(async (root, task) => {
    await writeFile(join(task, 'environment/input.bin'), 'changed');
    await expect(prepareTaskInputs(task, join(root, 'changed'), profile)).rejects.toThrow('changed');
    await mkdir(join(root, 'existing'));
    await expect(prepareTaskInputs(task, join(root, 'existing'), profile)).rejects.toThrow();
    await symlink(join(root, 'existing'), join(root, 'alias'));
    await expect(prepareTaskInputs(task, join(root, 'alias'), profile)).rejects.toThrow();
    await expect(prepareTaskInputs(task, join(root, 'alias/new'), profile)).rejects.toThrow('Symlinked');
  });
});

test('workspace aliases reject duplicate declarations', async () => {
  await fixture(async (root, task) => {
    await expect(prepareTaskInputs(task, join(root, 'bad'), { ...profile, workspaceAliases: ['/data', '/data'] })).rejects.toThrow();
  });
});

test('manifest refuses path escapes, undeclared files, hidden test sources, and duplicate targets', async () => {
  await fixture(async (root, task) => {
    for (const input of [
      { source: '../input.bin', target: 'input.bin' },
      { source: 'environment/../input.bin', target: 'input.bin' },
      { source: 'tests/input.bin', target: 'input.bin' },
      { source: 'environment/unknown.bin', target: 'input.bin' },
      { source: 'environment/input.bin', target: '../escape' },
      { source: 'environment/input.bin', target: '/absolute' },
      { source: 'environment/input.bin', target: '.hicode/settings.json' },
    ]) await expect(prepareTaskInputs(task, join(root, 'bad'), { ...profile, inputs: [input] })).rejects.toThrow();
    await expect(prepareTaskInputs(task, join(root, 'duplicate'), { ...profile, inputs: [...profile.inputs, ...profile.inputs] })).rejects.toThrow('unique');
  });
});

test('public test mount only stages already-public files, never hidden tests', async () => {
  await fixture(async (root, task) => {
    await mkdir(join(task,'tests'));await writeFile(join(task,'tests','answer.py'),'hidden');
    const helpers=join(root,'helpers');
    await preparePublicTestInputs(task,helpers,{...profile,publicTestInputs:[{source:'environment/input.bin',target:'filter.py'}]});
    expect(await readFile(join(helpers,'filter.py'))).toEqual(content);
    expect(Object.keys(await tree(helpers))).toEqual(['filter.py']);
    await expect(preparePublicTestInputs(task,join(root,'hidden'),{...profile,publicTestInputs:[{source:'tests/answer.py',target:'answer.py'}]})).rejects.toThrow('already be public');
    await expect(preparePublicTestInputs(task,join(root,'escape'),{...profile,publicTestInputs:[{source:'environment/input.bin',target:'../escape'}]})).rejects.toThrow();
    await expect(preparePublicTestInputs(task,join(root,'invalid'),{...profile,verifierChroot:true})).rejects.toThrow('private root');
  });
});
