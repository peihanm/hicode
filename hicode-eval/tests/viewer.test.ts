import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Minimal DOM records observable rendering and requests, without a browser or network.
class Element {
  hidden = false; open = false; textContent = ''; className = ''; dataset = {}; attributes: Record<string,string> = {}; children: Element[] = []; onclick?: () => void;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
test.each(['passed','failed','needs_recovery','error','setup_error'])('batch viewer distinguishes completion, collection and grading failures (%s)', async state => {
  const blocked=state==='needs_recovery',setupFailure=state==='setup_error';
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: string[] = []; const writes: string[] = [];
  const status = { inventory:{total:589,passed:231,unpassed:52,untested:306,running:0},concurrency: 2, schedulingBlocked: blocked, batches: [{ id: 'batch', name: '<img onerror=attack()>', createdAt: 1, model: { model: 'fixture', ...(state==='passed'?{reasoning:{effort:'max'}}:{}) }, concurrency: 2, budget: { agentSeconds: 900 }, payload: { commit: 'abc12345' }, counts: { total: 1, completed: 1, active: 0, queued: 0, passed: 1, failed: 0, errors: 0, cancelled: 0 }, state: 'finished', report: { text: '<script>bad()</script>' } }], runs: [{ batchId: 'batch', id: 'one', task: 'fixture', dataset:'terminal-bench-2.1', budget: {agentSeconds: 900}, state: 'passed', displayState: 'passed', evidencePath: '/tmp/fixture', execution: 'completed', grading: 'passed', collection: 'complete' }] };
  status.batches.push({ ...status.batches[0]!, id: 'batch-two', name: 'Older batch', createdAt: 0 });
  status.runs.push({ ...status.runs[0], id: 'two', task: 'queued-task', budget: {agentSeconds: 1800}, state: 'queued', displayState: 'queued', execution: 'pending', grading: 'pending', collection: 'pending' });
  status.runs.push({ ...status.runs[0]!, batchId: 'batch-two', id: 'three', task: 'other-task' });
  if (state!=='passed') {status.runs[0]!.state=setupFailure?'error':state;status.runs[0]!.displayState=setupFailure?'error':state;}
  if (state==='error')status.runs[0]!.grading='unavailable';
  if (state==='failed') {status.runs[0]!.grading='failed';Object.assign(status.batches[0]!.counts,{total:20,completed:20,passed:17,failed:3});}
  if(setupFailure)Object.assign(status.runs[0]!,{execution:'failed',grading:'pending',collection:'pending',note:'Worker deployment failed before startup'});
  const sizes: number[][] = [];
  let resized: (() => void) | undefined;
  let terminalRows = 40;
  Object.assign(el('terminal-shell'), {clientHeight: 340});
  Object.assign(el('terminal'), {querySelector: () => ({getBoundingClientRect: () => ({height: terminalRows * 16})})});
  class Terminal {
    get rows() { return terminalRows; }
    resize(cols: number, rows: number) { sizes.push([cols,rows]); terminalRows=rows; }
    parser = { registerOscHandler() {} }; buffer = { active: { viewportY: 0, baseY: 0 } };
    open() {} reset() {} refresh() {} scrollToBottom() {} scrollToLine() {}
    write(text: string, cb: () => void) { writes.push(text); cb(); }
  }
  let finish!: () => void; const rendered = new Promise<void>(r => { finish = r; });
  runInNewContext(await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: el, createElement: () => new Element() }, Terminal, AbortController, AbortSignal,
    getComputedStyle: () => ({paddingTop:'10px',paddingBottom:'10px'}),
    ResizeObserver: class { constructor(callback: () => void) {resized=callback;} observe() {} disconnect() {} },
    window: {addEventListener() {}},
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 200, json: async () => url === '/api/status' ? status : url.includes('preparation') ? { text: 'cache hit' } : (url.includes('run=two')||(setupFailure&&url.includes('run=one'))) ? { screen: '', revision: 'empty' } : { screen: 'final screen', revision: 'one' } }; },
    setTimeout: () => { finish(); }, clearTimeout: () => {},
  });
  await rendered;
  expect(el('batch-title').textContent).toBe('<img onerror=attack()>');
  expect(elements.has('report')).toBe(false);
  expect(elements.has('inventory')).toBe(false);
  expect(el('batch-detail').textContent).toContain('各题独立时限');
  expect(el('batch-detail').textContent).toContain('Reasoning: '+(state==='passed'?'max':'not recorded'));
  expect(el('batches').children[0].children[1].children[0].children[1].textContent).toContain('15 分钟');
  expect(el('batches').children[0].children[1].children[1].children[1].textContent).toContain('30 分钟');
  expect(el('detail').textContent).toContain('15 分钟');
  expect(el('batches').children[0].children[1].className).toBe('task-tree');
  expect(el('batches').children[0].children[0].attributes['aria-expanded']).toBe('true');
  expect(el('batches').children[1].children).toHaveLength(1);
  expect(el('terminal-shell').hidden).toBe(setupFailure);
  expect(el('terminal-status').textContent).toContain(setupFailure?'没有保存的终端画面':blocked ? '收尾异常' : state==='error'?'任务已结束 · 判题无法判定':state==='failed'?'任务已结束 · 判题未通过':'任务已结束 · 判题通过');
  if (blocked) expect(el('error').textContent).toContain('fixture');
  if (state==='error')expect(el('batches').children[0].children[1].children[0].children[1].textContent).toContain('判题异常 · 无法判定');
  expect(el('summary').children).toHaveLength(7);
  if(state==='failed'){
    expect(el('summary').children[3].children.map(e=>String(e.textContent))).toEqual(['17','通过']);
    expect(el('summary').children[4].children.map(e=>String(e.textContent))).toEqual(['3','未通过']);
    expect(el('batches').children[0].children[1].children[0].children[1].textContent).toContain('未通过');
  }
  expect(el('preparation').textContent).toContain('cache hit');
  if(setupFailure){expect(el('terminal-empty').textContent).toContain('Worker deployment failed');expect(el('detail').textContent).toContain('运行异常');expect(el('detail').textContent).not.toContain('Worker deployment failed');}
  expect(writes).toEqual(setupFailure?['']:['final screen']);
  expect(sizes).toEqual(setupFailure?[]:[[140,20]]);
  Object.assign(el('terminal-shell'), {clientHeight:180});resized!();
  if(!setupFailure)expect(sizes.at(-1)).toEqual([140,10]);
  expect(writes).toEqual(setupFailure?['']:['final screen']); // Resizing never replays the recording.
  const switched = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[0].children[1].children[1].onclick!();
  await switched;
  expect(el('title').textContent).toBe('Terminal-Bench 2.1 · queued-task');
  expect(el('detail').textContent).toContain('30 分钟');
  expect(el('terminal-shell').hidden).toBe(true);
  expect(el('terminal-empty').textContent).toContain(blocked ? '调度暂停' : '正在排队');
  expect(el('preparation-panel').open).toBe(false);
  const collapsed = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[0].children[0].onclick!();
  await collapsed;
  expect(el('batches').children[0].children).toHaveLength(1);
  expect(el('batches').children[0].children[0].attributes['aria-expanded']).toBe('false');
  expect(el('batch-title').textContent).toBe('<img onerror=attack()>');
  const opened = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[1].children[0].onclick!();
  await opened;
  expect(el('batches').children[0].children).toHaveLength(1);
  expect(el('batches').children[1].children[1].className).toBe('task-tree');
  expect(el('batches').children[1].children[0].attributes['aria-expanded']).toBe('true');
  expect(el('batch-title').textContent).toBe('Older batch');
  expect(requests.every(r => r.startsWith('/api/status') || r.startsWith('/api/terminal') || r.startsWith('/api/preparation'))).toBe(true);
});

test('rerun button sends one authenticated request, opens attempt 2 and links back without duplicate submission',async()=>{
 const elements=new Map<string,Element>();const el=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
 const batch={id:'batch',name:'original',createdAt:1,model:{model:'fixture'},concurrency:1,payload:{commit:'fixed'},runIds:['one'],counts:{total:1,completed:1,active:0,queued:0,passed:0,failed:0,errors:1,cancelled:0},state:'finished'};
 const original={id:'one',batchId:'batch',task:'fixture',dataset:'terminal-bench-2.1',budget:{agentSeconds:900},state:'error',displayState:'error',execution:'failed',grading:'unavailable',collection:'complete',evidencePath:'/fixture'};
 let child:(typeof batch & {retryOf:{runId:string;batchId:string;attempt:number}})|undefined;
 let posts=0,release:(()=>void)|undefined,rendered:(()=>void)|undefined;
 const tick=()=>new Promise<void>(resolve=>{rendered=resolve;});
 class Terminal{parser={registerOscHandler(){}};buffer={active:{viewportY:0,baseY:0}};open(){}reset(){}refresh(){}scrollToBottom(){}scrollToLine(){}write(_s:string,done:()=>void){done();}}
 const initial=tick();
 runInNewContext(await readFile(new URL('../src/web/app.js',import.meta.url),'utf8'),{
  document:{getElementById:el,createElement:()=>new Element()},Terminal,AbortController,AbortSignal,
  fetch:async(url:string,options?:{method:string;headers:Record<string,string>;body:string})=>{
   if(options?.method==='POST'){
    expect(url).toBe('/api/retry-run');expect(options.headers['X-Eval-Request']).toBe('1');expect(JSON.parse(options.body)).toEqual({run:'one'});posts++;
    await new Promise<void>(resolve=>{release=resolve;});
    child={...batch,id:'retry',name:'fixture · 第 2 次尝试',runIds:['two'],state:'running',retryOf:{runId:'one',batchId:'batch',attempt:2}};
    return {ok:true,status:200,json:async()=>({batch:child})};
   }
   return {ok:true,status:200,json:async()=>url==='/api/status'?{concurrency:1,schedulingBlocked:false,batches:child?[child,batch]:[batch],runs:child?[original,{...original,id:'two',batchId:'retry',state:'queued',displayState:'queued'}]:[original]}:url.includes('preparation')?{text:''}:{screen:'',revision:'empty'}};
  },
  setTimeout:()=>{rendered?.();},clearTimeout(){},
 });
 await initial;
 expect(el('run-action').textContent).toBe('重新运行');
 el('run-action').onclick!();el('run-action').onclick!();
 for(let i=0;i<20&&!release;i++)await Promise.resolve();
 expect(posts).toBe(1);
 const updated=tick();release!();await updated;
 expect(el('detail').textContent).toContain('第 2 次尝试');expect(el('run-action').hidden).toBe(true);
 expect(el('previous-attempt').hidden).toBe(false);
 const back=tick();el('previous-attempt').onclick!();await back;
 expect(el('detail').textContent).toContain('one');expect(el('run-action').textContent).toBe('查看重跑任务');
 const forward=tick();el('run-action').onclick!();await forward;
 expect(el('detail').textContent).toContain('第 2 次尝试');expect(posts).toBe(1);
});

function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function untilAborted(signal:AbortSignal):Promise<never>{
  return new Promise((_resolve,reject)=>{
    if(signal.aborted)reject(signal.reason);
    else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
}
async function viewerFixture(intercept:(url:string,signal:AbortSignal)=>Promise<unknown>|undefined){
  const elements=new Map<string,Element>();
  const el=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
  const batch={id:'batch',name:'fixture',createdAt:1,model:{model:'fixture'},concurrency:2,payload:{commit:'fixture'},state:'running',counts:{total:2,completed:0,active:2,queued:0,passed:0,failed:0,errors:0,cancelled:0}};
  const runs=['one','two'].map(id=>({id,batchId:'batch',task:id,dataset:'terminal-bench-2.1',budget:{agentSeconds:1800},state:'running',displayState:'running',execution:'pending',grading:'pending',collection:'pending',evidencePath:'/fixture'}));
  const requests:{url:string;signal:AbortSignal;deadline:AbortController}[]=[];
  const deadlines:AbortController[]=[];const polls:(()=>void)[]=[];const writes:string[]=[];let paints=0;
  class Terminal{
    rows=40;parser={registerOscHandler(){}};buffer={active:{viewportY:0,baseY:0}};
    open(){}reset(){}scrollToBottom(){}scrollToLine(){}refresh(){paints++;}
    write(text:string,done:()=>void){writes.push(text);done();}
  }
  const drain=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
  runInNewContext(await readFile(new URL('../src/web/app.js',import.meta.url),'utf8'),{
    document:{getElementById:el,createElement:()=>new Element()},Terminal,AbortController,
    AbortSignal:{any:(signals:AbortSignal[])=>AbortSignal.any(signals),timeout:(ms:number)=>{expect(ms).toBe(10000);const deadline=new AbortController();deadlines.push(deadline);return deadline.signal;}},
    fetch:async(url:string,options:{signal:AbortSignal})=>{
      requests.push({url,signal:options.signal,deadline:deadlines.at(-1)!});
      const packet=intercept(url,options.signal);
      return {ok:true,status:200,json:async()=>packet??(url==='/api/status'?{batches:[batch],runs,concurrency:2,schedulingBlocked:false}:url.includes('preparation')?{text:url.includes('run=two')?'two log':'one log'}:{screen:url.includes('run=two')?'two screen':'one screen',revision:url.includes('run=two')?'two-r1':'one-r1'})};
    },
    setTimeout:(callback:()=>void)=>{polls.push(callback);return callback;},
    clearTimeout:(callback:()=>void)=>{const index=polls.indexOf(callback);if(index!==-1)polls.splice(index,1);},
  });
  await drain();
  return {el,requests,writes,drain,get paints(){return paints;},
    async select(index:number){el('batches').children[0]!.children[1]!.children[index]!.onclick!();await drain();},
    async poll(){expect(polls.length).toBeGreaterThan(0);polls.shift()!();await drain();},
  };
}

test('slow preparation log cannot block terminal display or subsequent terminal polling',async()=>{
  const pending=deferred<unknown>();let frame=0;
  const view=await viewerFixture(url=>url.includes('preparation')?pending.promise:url.includes('terminal')?Promise.resolve({screen:'frame '+(++frame),revision:String(frame)}):undefined);
  expect(view.writes).toEqual(['frame 1']);expect(view.el('terminal-shell').hidden).toBe(false);expect(view.paints).toBe(1);
  await view.poll();
  expect(view.writes).toEqual(['frame 1','frame 2']);
  expect(view.requests.filter(r=>r.url.includes('preparation'))).toHaveLength(1);
  expect(view.requests.filter(r=>r.url.includes('terminal'))[1]!.url).toContain('revision=1');
  pending.resolve({text:'eventually ready'});await view.drain();expect(view.el('preparation').textContent).toBe('eventually ready');
});

test('log failure stays local and retries while terminal remains visible',async()=>{
  let logs=0;
  const view=await viewerFixture(url=>url.includes('preparation')&&++logs===1?Promise.reject(new Error('log unavailable')):undefined);
  expect(view.el('preparation').textContent).toContain('log unavailable');expect(view.el('terminal-shell').hidden).toBe(false);
  expect(view.el('connection').textContent).toContain('已连接');
  await view.poll();expect(view.el('preparation').textContent).toBe('one log');
});

test('switching tasks aborts pending terminal reads and ignores late previous logs',async()=>{
  const oldLog=deferred<unknown>();
  const view=await viewerFixture((url,signal)=>url.includes('preparation?run=one')?oldLog.promise:url.includes('terminal?run=one')?untilAborted(signal):undefined);
  expect(view.el('terminal-shell').hidden).toBe(true);
  await view.select(1);
  expect(view.requests.find(r=>r.url.includes('terminal?run=one'))!.signal.aborted).toBe(true);
  expect(view.requests.find(r=>r.url.includes('preparation?run=one'))!.signal.aborted).toBe(true);
  expect(view.el('title').textContent).toBe('Terminal-Bench 2.1 · two');expect(view.writes).toEqual(['two screen']);
  expect(view.requests.find(r=>r.url.includes('terminal?run=two'))!.url).toEndWith('revision=');
  oldLog.resolve({text:'stale one log'});await view.drain();
  expect(view.el('preparation').textContent).toBe('two log');expect(view.el('error').textContent).toBe('');
});

test.each(['status','preparation','terminal'])('%s timeout releases its request and recovers automatically',async endpoint=>{
  let blocked=true;
  const view=await viewerFixture((url,signal)=>blocked&&url.startsWith('/api/'+endpoint)?untilAborted(signal):undefined);
  const request=view.requests.find(r=>r.url.startsWith('/api/'+endpoint))!;
  request.deadline.abort(new DOMException('read deadline','TimeoutError'));await view.drain();
  if(endpoint==='preparation'){
    expect(view.el('preparation').textContent).toContain('读取失败');expect(view.el('terminal-shell').hidden).toBe(false);
  }else expect(view.el('error').textContent).toContain('读取超时');
  blocked=false;await view.poll();
  expect(view.el('terminal-shell').hidden).toBe(false);expect(view.el('preparation').textContent).toBe('one log');
  expect(view.el('error').textContent).toBe('');
});

test('unchanged terminal revision preserves the rendered frame without periodic rewrites',async()=>{
  let reads=0;
  const view=await viewerFixture(url=>url.includes('terminal')?Promise.resolve(++reads===1?{screen:'saved frame',revision:'stable'}:{revision:'stable'}):undefined);
  await view.poll();
  expect(view.writes).toEqual(['saved frame']);expect(view.paints).toBe(1);
  expect(view.el('terminal-shell').hidden).toBe(false);
  expect(view.requests.filter(r=>r.url.includes('terminal'))[1]!.url).toContain('revision=stable');
});
