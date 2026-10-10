import { dirname, join, resolve } from 'node:path';
import { mkdir, copyFile, realpath, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { readJson, tree } from './store.js';
export const taskSchema = z.object({ metadata: z.object({ category: z.string().optional() }).optional(), agent: z.object({ timeout_sec: z.number().positive() }), verifier: z.object({ timeout_sec: z.number().positive() }), environment:z.object({allow_internet:z.boolean().optional()}).optional() });
export async function publicTaskNetwork(source:string):Promise<'open'|'isolated'>{
  const spec=taskSchema.parse(Bun.TOML.parse(await readFile(join(source,'task.toml'),'utf8')));
  return spec.environment?.allow_internet===true?'open':'isolated';
}
const inputPath = z.string().max(256).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const profileSchema = z.object({
  hashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  inputs: z.array(z.object({ source: inputPath.refine(path => path.startsWith('environment/')), target: inputPath }).strict()).max(256),
  publicTestInputs: z.array(z.object({ source: inputPath, target: inputPath }).strict()).max(32).default([]),
  initializer: z.object({kind:z.enum(['python','bash','gzip']),file:z.string().regex(/^[A-Za-z0-9_.-]+$/)}).strict().nullable(),
  directories: z.array(inputPath).max(64),
  packages: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*$/)).max(16),
  verifierPackages: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*$/)).max(16).default([]),
  verifierPrelude: z.enum(['copy-test-helper','compile-feal-extension','reset-large-csv','none']),
  commands: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.+-]*$/)).default([]),
  systemPackages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~_-]+)?$/)).max(128).optional(),
  workspaceAliases: z.array(z.enum(['/data','/workspace','/tmp/CompCert'])).max(3).optional(),
  writableRuntimeBin: z.boolean().optional(),
  service: z.object({writablePaths:z.array(z.enum(['/etc','/var','/run','/home','/git','/srv'])).max(6)}).strict().optional(),
  verifierInputs: z.array(z.object({source:inputPath.refine(path=>path.startsWith('tests/')),target:inputPath}).strict()).max(32).optional(),
  verifierSetup: inputPath.optional(),
  verifierWritableTests: z.boolean().optional(),
  verifierTestPaths: z.array(z.string().regex(/^\/(?:app|tests)(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/)).min(1).max(32).optional(),
  verifierPython: z.literal('/opt/hicode-task/verifier/bin/python').optional(),
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.string().max(1024)).default({}),
  verifierEnvironment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.string().max(1024)).default({}),
  verifierRootOverlay: z.boolean().default(false),
  verifierChroot: z.boolean().default(false)
}).strict().superRefine((profile, ctx) => {
  const targets = new Set<string>();
  if(profile.service){
    if(new Set(profile.service.writablePaths).size!==profile.service.writablePaths.length)
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Service system paths must be unique'});
    if(profile.verifierChroot||profile.verifierRootOverlay)
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Services require the separate live verifier view'});
  }
  if (profile.workspaceAliases && new Set(profile.workspaceAliases).size !== profile.workspaceAliases.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Workspace aliases must be unique'});
  for (const input of profile.inputs) {
    if (profile.writableRuntimeBin && (input.target==='runtime-bin' || input.target.startsWith('runtime-bin/')))
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Runtime executable directory is reserved'});
    if (!profile.hashes[input.source] || targets.has(input.target) || input.target === profile.initializer?.file)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inputs must have reviewed hashes and unique destinations' });
    targets.add(input.target);
  }
  if (profile.initializer && !profile.hashes['environment/' + profile.initializer.file])
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Initializer must be a reviewed environment file'});
  if (profile.directories.some(path => targets.has(path) || profile.initializer?.file === path ||
      (profile.writableRuntimeBin && (path==='runtime-bin' || path.startsWith('runtime-bin/')))))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Output directories must not collide with input files'});
  if (profile.packages.some((value, index) => profile.packages.indexOf(value) !== index))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Task-local package pins must be unique'});
  if (profile.verifierPackages.some((value, index) => profile.verifierPackages.indexOf(value) !== index))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Verifier package pins must be unique'});
  if (profile.verifierChroot && !profile.verifierRootOverlay)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Chroot verification requires a private root'});
  const publicTargets = new Set<string>();
  const verifierTargets=new Set<string>();
  for (const entry of profile.verifierInputs??[]) {
    if (!profile.hashes[entry.source] || verifierTargets.has(entry.target) || entry.target==='runtime-bin' || entry.target.startsWith('runtime-bin/'))
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Verifier inputs require reviewed hashes and unique non-runtime destinations'});
    verifierTargets.add(entry.target);
  }
  if (profile.verifierSetup && !profile.hashes['tests/'+profile.verifierSetup])
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Verifier setup must be a reviewed test file'});
  for (const entry of profile.publicTestInputs) {
    if (!profile.inputs.some(input => input.source === entry.source) || publicTargets.has(entry.target))
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Public test helpers must already be public inputs with unique destinations'});
    publicTargets.add(entry.target);
  }
});
export function publicTaskProfile(manifest:Record<string,unknown>,id:string){
  if(!Object.hasOwn(manifest,id))throw Error('Public task has not been adapted to the shared Linux machine');
  return profileSchema.parse(manifest[id]);
}
export async function validatePublicTask(id: string, path: string, definition:string) {
  const manifest=await readJson(definition,z.record(z.unknown()));
  const profile=publicTaskProfile(manifest,id);
  const files = await tree(path);
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(profile.hashes).sort()) || Object.entries(profile.hashes).some(([name, hash]) => files[name]?.sha256 !== hash)) throw Error('Public task differs from the reviewed dataset revision');
  return profile;
}

/** Only explicitly reviewed public inputs enter the Agent workspace, never the whole task. */
export async function prepareTaskInputs(task: string, destination: string, input: z.input<typeof profileSchema>): Promise<void> {
  const profile = profileSchema.parse(input);
  if (await realpath(dirname(destination)) !== resolve(dirname(destination))) throw Error('Symlinked input parent');
  await mkdir(destination, { mode: 0o700 });
  for (const directory of profile.directories) await mkdir(join(destination, directory), {recursive:true, mode:0o700});
  for (const input of profile.inputs) {
    const target = join(destination, input.target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(task, input.source), target, constants.COPYFILE_EXCL);
  }
  const files = await tree(destination);
  if (Object.keys(files).length !== profile.inputs.length || profile.inputs.some(input => files[input.target]?.sha256 !== profile.hashes[input.source]))
    throw Error('Task inputs changed during preparation');
}

/** This mount contains only already-public helpers, not the deferred verifier. */
export async function preparePublicTestInputs(task: string, destination: string, input: z.input<typeof profileSchema>): Promise<void> {
  const profile = profileSchema.parse(input);
  if (await realpath(dirname(destination)) !== resolve(dirname(destination))) throw Error('Symlinked public-helper parent');
  await mkdir(destination, {mode: 0o700});
  for (const entry of profile.publicTestInputs) {
    const target = join(destination, entry.target);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await copyFile(join(task, entry.source), target, constants.COPYFILE_EXCL);
  }
  const files = await tree(destination);
  if (Object.keys(files).length !== profile.publicTestInputs.length || profile.publicTestInputs.some(entry => files[entry.target]?.sha256 !== profile.hashes[entry.source]))
    throw Error('Public helpers changed during preparation');
}
