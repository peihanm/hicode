import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareTaskInputs, preparePublicTestInputs, profiles, publicTaskProfile } from '../src/host/publicTasks.js';
import { tree } from '../src/host/store.js';

const content = Buffer.from([0, 255, 10, 128, 42]);
const hash = createHash('sha256').update(content).digest('hex');
const profile = { hashes: { 'environment/input.bin': hash }, inputs: [{ source: 'environment/input.bin', target: 'input.bin' }], initializer: null, directories: [], packages: [], verifierPackages: [], verifierPrelude: 'none' as const };

test('a malformed unrelated task profile cannot invalidate an active task',async()=>{
  const manifest={fixture:profile,unrelated:{...profile,hashes:{'instruction.md':'short'}}};
  expect(publicTaskProfile(manifest,'fixture').inputs).toEqual(profile.inputs);
  expect(()=>publicTaskProfile(manifest,'unrelated')).toThrow();
  expect(()=>publicTaskProfile(manifest,'missing')).toThrow('not been adapted');
  expect(Object.keys(await profiles('terminal-bench-2.1')).length).toBeGreaterThan(60);
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

test('catalog includes reviewed tasks with the exact newly required inputs', async () => {
  const available = await profiles('terminal-bench');
  expect(Object.keys(available)).toHaveLength(55);
  expect(available['torch-tensor-parallelism']!.packages).toEqual(['torch==2.7.0']);
  expect(available['torch-pipeline-parallelism']!.verifierPackages).toEqual(['torch==2.7.0','transformers==4.55.0']);
  expect(available['pytorch-model-recovery']!.inputs.map(file=>file.target)).toEqual(['dataset.pt','weights.pt']);
  expect(available['sqlite-db-truncate']!.inputs.map(file => file.target)).toEqual(['trunc.db']);
  expect(available['code-from-image']!.inputs.map(file => file.target)).toEqual(['code.png']);
  expect(available['constraints-scheduling']!.inputs.map(file => file.target)).toEqual(['alice_calendar.ics', 'bob_calendar.ics', 'carol_calendar.ics']);
  expect(available['gcode-to-text']!.initializer).toEqual({kind:'gzip',file:'text.gcode.gz'});
  expect(available['git-leak-recovery']!.initializer).toEqual({kind:'bash',file:'challenge-setup.sh'});
  expect(available['llm-inference-batching-scheduler']!.directories).toEqual(['task_file/output_data']);
  expect(available['llm-inference-batching-scheduler']!.inputs.map(file => file.target)).toContain('task_file/scripts/cost_model.py');
  expect(available['llm-inference-batching-scheduler']!.inputs.every(file => !file.target.startsWith('environment/'))).toBe(true);
  expect(available['raman-fitting']!.packages).toEqual(['numpy==2.3.3','scipy==1.16.2']);
  expect(available['schemelike-metacircular-eval']!.inputs.some(file => file.target === 'test/y_combinator.scm')).toBe(true);
  expect(available['schemelike-metacircular-eval']!.inputs.some(file => file.target.includes('shadow_test'))).toBe(false);
  expect(available['merge-diff-arc-agi-task']!.inputs.map(file => file.target)).toEqual(['bundle1.bundle','bundle2.bundle','examples.json']);
  expect(available['sparql-university']!.packages).toEqual(['rdflib==7.1.4']);
  expect(available['model-extraction-relu-logits']!.packages).toEqual(['numpy==2.2.5']);
  expect(available['model-extraction-relu-logits']!.verifierPackages).toEqual(['numpy==2.3.1']);
  expect(available['db-wal-recovery']!.inputs.map(file => file.target)).toEqual(['main.db','main.db-wal']);
  expect(available['chess-best-move']!.inputs.map(file => file.target)).toEqual(['chess_board.png']);
  // Only sim.c is public in the upstream Dockerfile; adjacent hidden tests must stay out.
  expect(available['circuit-fibsqrt']!.inputs).toEqual([
    { source: 'environment/tests/sim.c', target: 'sim.c' },
    { source: 'environment/gates.txt', target: 'gates.txt' },
  ]);
  expect(available['protein-assembly']!.inputs.map(file => file.target)).toEqual(['antibody.fasta', 'plasmid.gb', 'pdb_ids.txt']);
  expect(available['distribution-search']!.packages).toEqual(['numpy==2.1.2', 'scipy==1.15.3']);
  expect(available['distribution-search']!.verifierPackages).toEqual(['numpy==2.3.0']);
  expect(available['cobol-modernization']!.inputs.every(file => /^(src|data)\//.test(file.target))).toBe(true);
  expect(available['write-compressor']!.initializer).toEqual({ kind: 'bash', file: 'eval-build-decomp.sh' });
  expect(available['write-compressor']!.inputs.map(file => file.target)).toEqual(['decomp.c', 'data.txt']);
  expect(available['modernize-scientific-stack']!.inputs.every(file => file.target.startsWith('climate_analyzer/'))).toBe(true);
  expect(available['portfolio-optimization']!.inputs.some(file => file.target === 'cvxopt_benchmark.py')).toBe(false);
  expect(available['video-processing']!.inputs.map(file => file.target)).toEqual(['example_video.mp4']);
  expect(available['video-processing']!.packages).toContain('toml==0.10.2');
  expect(available['fix-git']!.initializer).toEqual({ kind: 'bash', file: 'eval-setup.sh' });
  expect(available['fix-git']!.inputs).toContainEqual({source:'environment/fix-git-input.tar',target:'fix-git-input.tar'});
  const gitInitializer=await readFile(new URL('../config/initializers/fix-git.sh',import.meta.url));
  expect(available['fix-git']!.hashes['environment/eval-setup.sh']).toBe(createHash('sha256').update(gitInitializer).digest('hex'));
  expect(available['fix-git']!.hashes['environment/setup.sh']).toBe('99125cf2e362f2f4a864ba2f55c2f0e9f0aa0641fed588cef588184fcc192de2');
  expect(available['vulnerable-secret']!.initializer).toEqual({ kind: 'bash', file: 'eval-setup.sh' });
  expect(available['query-optimize']!.inputs.map(file => file.target)).toEqual(['my-sql-query.sql', 'oewn.sqlite']);
  expect(available['query-optimize']!.commands).toContain('sqlite3');
  expect(available['dna-assembly']!.commands).toEqual(['oligotm']);
  expect(available['dna-insert']!.commands).toEqual(['oligotm']);
  expect(available['break-filter-js-from-html']!.publicTestInputs).toEqual([{source:'environment/filter.py',target:'filter.py'}]);
  expect(available['path-tracing']!.verifierChroot).toBe(true);
  expect(available['path-tracing-reverse']!.verifierChroot).toBe(true);
  expect(available['financial-document-processor']!.inputs.filter(file => file.target.startsWith('seed-documents/'))).toHaveLength(17);
  expect(available['tune-mjcf']!.packages).toEqual(['mujoco==3.3.5']);
  expect(available['bn-fit-modify']!.verifierPackages).toEqual(['pandas==2.3.2', 'scipy==1.16.1']);
  expect(available['overfull-hbox']!.inputs.map(file => file.target)).toEqual(['main.tex', 'input.tex', 'synonyms.txt']);
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
