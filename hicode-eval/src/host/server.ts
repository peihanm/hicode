import {join} from 'node:path';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {Lab} from './manager.js';
import {Client} from './client.js';
import {EvaluationView} from './view.js';
import {EVAL_ROOT} from '../paths.js';
import {submissionSchema,idSchema,environmentPreparationSchema,serviceRegradeRequestSchema} from './types.js';
import {exists} from './store.js';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const healthSchema=z.object({data:z.string(),schedulingBlocked:z.boolean()}).strict();
const mutations={submit:submissionSchema,'prepare-environments':environmentPreparationSchema,'cancel-batch':z.object({batch:idSchema}).strict(),
  'regrade-service':serviceRegradeRequestSchema,
  'resume-batch':z.object({batch:idSchema}).strict(),'recover-run':z.object({run:idSchema}).strict(),
  'retry-run':z.object({run:idSchema}).strict(),report:z.object({batch:idSchema,text:z.string().trim().min(1).max(200000)}).strict(),
  cancel:z.object({run:idSchema}).strict()};
type Mutation=keyof typeof mutations;
function mutation(path:string):Mutation|undefined{return Object.hasOwn(mutations,path)?path as Mutation:undefined;}

function localServer(port:number,role:'worker'|'dashboard',handle:(request:Request,url:URL)=>Promise<Response>){
  const token=randomBytes(32).toString('hex'),cookieName='eval_'+role;
  const server:ReturnType<typeof Bun.serve>=Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:256*1024,idleTimeout:255,async fetch(request){
    const url=new URL(request.url),origin=request.headers.get('origin');
    const allowed=new Set(['127.0.0.1:'+server.port,'localhost:'+server.port]);
    if(!allowed.has(request.headers.get('host')??'')||(origin&&!['http://127.0.0.1:'+server.port,'http://localhost:'+server.port].includes(origin)))
      return json({error:'Local request required'},403);
    const root=request.method==='GET'&&url.pathname==='/';
    const cookie=request.headers.get('cookie')?.match(new RegExp('(?:^|;\\s*)'+cookieName+'=([a-f0-9]{64})(?:;|$)'))?.[1];
    if(!root&&(!cookie||!timingSafeEqual(Buffer.from(cookie),Buffer.from(token))))return json({error:'Local session required'},403);
    if(request.method==='POST'&&request.headers.get('X-Eval-Request')!=='1')return json({error:'Local request required'},403);
    let response:Response;
    try{response=await handle(request,url);}catch(error){response=json({error:error instanceof Error?error.message.slice(0,250):'Invalid request'},400);}
    const headers=new Headers(response.headers);
    headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');
    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    if(root)headers.set('Set-Cookie',cookieName+'='+token+'; HttpOnly; SameSite=Strict; Path=/');
    return new Response(response.body,{status:response.status,headers});
  }});
  if(server.port===undefined){server.stop(true);throw Error('Expected a loopback TCP listener');}
  return {port:server.port,stop(force=false){server.stop(force);}};
}

async function details(path:string,kind:'preparation'|'terminal',revision:string|null){
  if(kind==='preparation'){
    const sections:string[]=[];let truncated=false;
    for(const [name,title,budget] of [['preparation.log','执行阶段',8000],['collection-error.txt','周期采集诊断（不代表执行失败）',2000],['verification.txt','判题输出',54000]] as const){
      const file=join(path,name);if(!await exists(file))continue;
      const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await fd.stat();if(!stat.isFile())throw Error('Invalid log');
        const length=Math.min(stat.size,budget),buffer=Buffer.alloc(length);
        const {bytesRead}=await fd.read(buffer,0,length,stat.size-length);
        sections.push(title+'\n'+buffer.subarray(0,bytesRead).toString('utf8'));truncated||=stat.size>length;
      }finally{await fd.close();}
    }
    return json({text:sections.join('\n\n'),truncated});
  }
  const file=join(path,'live/screen.txt');if(!await exists(file))return json({screen:'',revision:'empty'});
  if(await realpath(join(path,'live'))!==join(path,'live'))throw Error('Symlinked terminal directory');
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await fd.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw Error('Invalid terminal snapshot');
    const current=`${stat.mtimeMs}:${stat.size}`;
    return json(revision===current?{revision:current}:{revision:current,screen:await fd.readFile('utf8')});
  }finally{await fd.close();}
}

/** Owns only the HTTP listener; Lab's creator owns execution and shutdown. */
export function serveWorker(lab:Lab,port:number){
  return localServer(port,'worker',async(request,url)=>{
    if(request.method==='GET'){
      if(url.pathname==='/'||url.pathname==='/api/health')return json(lab.health());
      if(url.pathname==='/api/status')return json(await lab.snapshot());
      if(url.pathname==='/api/recheck')return json(await lab.recheck(idSchema.parse(url.searchParams.get('run')),idSchema.parse(url.searchParams.get('review'))));
      if(url.pathname==='/api/preparation'||url.pathname==='/api/terminal')
        return details(lab.path(idSchema.parse(url.searchParams.get('run'))),url.pathname==='/api/preparation'?'preparation':'terminal',url.searchParams.get('revision'));
    }
    if(request.method==='POST'){
      const name=mutation(url.pathname.slice(5));if(!url.pathname.startsWith('/api/')||!name)return json({error:'Not found'},404);
      const body:unknown=await request.json();
      if(name==='submit')return json({batch:await lab.submit(submissionSchema.parse(body))});
      if(name==='prepare-environments')return json(await lab.prepareEnvironments(environmentPreparationSchema.parse(body)));
      if(name==='regrade-service')return json(await lab.regrade(serviceRegradeRequestSchema.parse(body)));
      if(name==='report'){const args=mutations.report.parse(body);await lab.report(args.batch,args.text);return json({ok:true});}
      if(name==='cancel-batch'||name==='resume-batch'){
        const args=mutations[name].parse(body);
        if(name==='cancel-batch')await lab.cancelBatch(args.batch);else await lab.resume(args.batch);
        return json({ok:true});
      }
      const args=mutations[name].parse(body);
      if(name==='recover-run')return json({run:await lab.recover(args.run)});
      if(name==='retry-run')return json({batch:await lab.retry(args.run)});
      await lab.cancel(args.run);return json({ok:true});
    }
    return json({error:'Not found'},404);
  });
}

/** Read-only disk view plus authenticated commands to the sole execution owner. */
export function serve(view:EvaluationView,worker:Client,port:number){
  const health=async(signal:AbortSignal)=>{
    const value=healthSchema.parse(await worker.request('health',undefined,signal));
    if(value.data!==view.data)throw Error('Worker belongs to another evaluation data directory');
    return value;
  };
  return localServer(port,'dashboard',async(request,url)=>{
    if(request.method==='GET'){
      if(url.pathname==='/')return new Response(Bun.file(join(EVAL_ROOT,'src/web/index.html')),{headers:{'Content-Type':'text/html; charset=utf-8'}});
      const assets:Record<string,string>={'/app.js':'text/javascript','/style.css':'text/css','/vendor/xterm.js':'text/javascript','/vendor/xterm.css':'text/css'};
      if(assets[url.pathname])return new Response(Bun.file(join(EVAL_ROOT,'src/web',url.pathname)),{headers:{'Content-Type':assets[url.pathname]!}});
      if(url.pathname==='/api/status'){
        const state=await health(AbortSignal.any([request.signal,AbortSignal.timeout(750)])).catch(()=>undefined);
        return json({...await view.snapshot(state?.schedulingBlocked),workerConnected:state!==undefined});
      }
      if(url.pathname==='/api/preparation'||url.pathname==='/api/terminal')
        return details(await view.path(idSchema.parse(url.searchParams.get('run'))),url.pathname==='/api/preparation'?'preparation':'terminal',url.searchParams.get('revision'));
    }
    if(request.method==='POST'){
      const name=mutation(url.pathname.slice(5));if(!url.pathname.startsWith('/api/')||!name)return json({error:'Not found'},404);
      // Fail closed on commands; viewing archived/live records never depends on worker health.
      await health(AbortSignal.any([request.signal,AbortSignal.timeout(2000)]));
      const body=mutations[name].parse(await request.json());
      return json(await worker.request(name,body,request.signal));
    }
    return json({error:'Not found'},404);
  });
}
