import {z} from 'zod';
import {validatePublicTask} from './publicTasks.js';
import {validateSweTask, datasetTree} from './sweTasks.js';
import {tree} from './store.js';

export const datasetSchema=z.enum(['terminal-bench','terminal-bench-2.1','swe-bench-verified']);
export type Dataset=z.infer<typeof datasetSchema>;
export const taskRefSchema=z.object({dataset:datasetSchema,id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/)}).strict();
export type TaskRef=z.infer<typeof taskRefSchema>;
export function taskKey(task:TaskRef):string{return task.dataset+':'+task.id;}

export type TaskMetadata=Awaited<ReturnType<typeof validateSweTask>>|Awaited<ReturnType<typeof validatePublicTask>>;
type TaskAdapter={
  validate:(id:string,source:string)=>Promise<TaskMetadata>;
  snapshot:(source:string)=>ReturnType<typeof tree>;
};

const terminal=(dataset:'terminal-bench'|'terminal-bench-2.1'):TaskAdapter=>({
  validate:(id,source)=>validatePublicTask(id,source,dataset),
  snapshot:tree,
});
export const taskAdapters:Record<Dataset,TaskAdapter>={
  'terminal-bench':terminal('terminal-bench'),
  'terminal-bench-2.1':terminal('terminal-bench-2.1'),
  'swe-bench-verified':{validate:validateSweTask,snapshot:source=>datasetTree(source,'swe-bench-verified')},
};
