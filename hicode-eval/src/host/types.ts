import { z } from 'zod';
import { LLM_PROVIDER_NAMES } from '../../../src/llm/providerRegistry.js';
import {datasetSchema,taskRefSchema} from './datasets.js';
import {EvalLayout} from './layout.js';
import {readJson} from './store.js';
export const idSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const modelSchema = z.object({ source: z.enum(LLM_PROVIDER_NAMES), model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), baseUrl: z.string().url().refine(s => { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }), imageInput: z.boolean().optional() }).strict();
export const budgetSchema = z.object({ agentSeconds: z.number().int().min(30).max(10800).default(1800) }).strict();
export type Budget = z.infer<typeof budgetSchema>;
export const networkSchema = z.enum(['open', 'isolated']);
const batchName = z.string().trim().min(1).max(120);
const concurrency = z.number().int().min(1).max(5).default(2);
const retryOriginSchema=z.object({batchId:idSchema,runId:idSchema,attempt:z.number().int().min(2).max(1000)}).strict();
export const submissionSchema = z.object({ name: batchName, network: networkSchema.optional(), tasks: z.array(z.object({ id: z.string().min(1), dataset:datasetSchema, agentSeconds: z.number().int().min(30).max(10800).optional() }).strict()).min(1).max(200), concurrency }).strict();
export const environmentPreparationSchema=z.object({tasks:z.array(taskRefSchema).min(1).max(200),buildProxy:z.string().url().refine(value=>{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}).optional()}).strict();
export type EnvironmentPreparation=z.infer<typeof environmentPreparationSchema>;
export type Submission = z.infer<typeof submissionSchema>;
// The batch records its default; resolved execution limits belong to each Run.
export const batchSchema = z.object({ name: batchName, network: networkSchema.default('open'), taskRefs:z.array(taskRefSchema).min(1).max(200), concurrency, budget: budgetSchema, version: z.literal(1), id: idSchema, createdAt: z.number(), runIds: z.array(idSchema), model: modelSchema, payload: z.record(z.unknown()), retryOf:retryOriginSchema.optional(),cancelledAt: z.number().optional(), report: z.object({ text: z.string().trim().min(1).max(200000), updatedAt: z.number() }).optional() }).strict();
export type Batch = z.infer<typeof batchSchema>;
export const runSchema = z.object({ version: z.literal(1), network: networkSchema.default('open'), id: idSchema, batchId: idSchema, task: z.string().min(1), dataset: datasetSchema, state: z.enum(['queued', 'preparing', 'running', 'verifying', 'passed', 'failed', 'error', 'cancelled', 'cancelling', 'needs_recovery']), createdAt: z.number(), updatedAt: z.number(), startedAt: z.number().optional(), finishedAt: z.number().optional(), model: z.string(),  budget: budgetSchema, execution: z.enum(['pending', 'completed', 'timeout', 'cancelled', 'failed']).default('pending'), grading: z.enum(['pending', 'passed', 'failed', 'unavailable']).default('pending'), collection: z.enum(['pending', 'complete', 'retained']).default('pending'), note: z.string().optional(), reward: z.number().optional() }).strict();
export type Run = z.infer<typeof runSchema>;
export const regradeResultSchema=z.object({version:z.literal(1),runId:idSchema,instanceId:z.string().min(1),patchSha256:z.string().regex(/^[a-f0-9]{64}$/),
  grading:z.enum(['passed','failed','unavailable']),reason:z.string().nullable(),originalExecution:runSchema.shape.execution,modelCalls:z.literal(0)}).strict();
export const done = (s: Run['state']): boolean => ['passed', 'failed', 'error', 'cancelled', 'needs_recovery'].includes(s);
export const liveSchema = z.object({ phase: z.string(), event: z.string().nullable().optional(), updatedAt: z.number().optional(), lastEventAt: z.number().optional(), ready: z.boolean().optional(), bytes: z.record(z.number()).optional() });
export const containerSchema = z.object({ session: z.string(), id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/), attach: z.string() });
export const datasetBackendsSchema=z.record(datasetSchema,z.object({context:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/),cpus:z.number().positive().max(64),memoryMb:z.number().int().min(256).max(65536)}).strict());
export type DatasetBackends=z.infer<typeof datasetBackendsSchema>;
export const settingsSchema=z.object({version:z.literal(1),datasetBackends:datasetBackendsSchema.default({}),network:networkSchema.default('isolated'),context:z.string().min(1),machine:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/),concurrency:z.number().int().min(1).max(5),cpus:z.number().positive().max(64).default(1),memoryMb:z.number().int().min(256).max(65536).default(4096),budget:budgetSchema,model:modelSchema,cacheGiB:z.number().int().min(1).max(64).default(8)}).strict();
export const configSchema=settingsSchema.extend({data:z.string()}).transform(value=>{
  const layout=new EvalLayout(value.data);
  return {...value,data:layout.root,catalog:layout.catalog,environments:layout.environments,payload:layout.payload};
});
export type Config=z.infer<typeof configSchema>;
export async function loadConfig(root:string):Promise<Config>{
  const layout=new EvalLayout(root);await layout.assert();
  return configSchema.parse({...await readJson(layout.settings,settingsSchema),data:layout.root});
}
