'use strict';
const $=id=>document.getElementById(id);
const terminal=new Terminal({cols:140,rows:40,disableStdin:true,scrollback:20000,fontSize:12,
  fontFamily:'Menlo, Consolas, monospace',minimumContrastRatio:4.5,
  theme:{background:'#ffffff',foreground:'#303b49',cursor:'#087f72',cursorAccent:'#ffffff',
    selectionBackground:'#d3e6df',selectionForeground:'#162d32',
    black:'#303b49',red:'#b54549',green:'#087568',yellow:'#8a650c',blue:'#2565a6',magenta:'#8752a1',cyan:'#147a88',white:'#687487',
    brightBlack:'#687487',brightRed:'#c33742',brightGreen:'#087f72',brightYellow:'#946b00',brightBlue:'#286ec0',brightMagenta:'#9554b3',brightCyan:'#087d91',brightWhite:'#465366'},
  allowProposedApi:false});
// Measure the terminal while visible; it remains hidden until a snapshot is available.
$('terminal-shell').hidden=false;
terminal.open($('terminal'));
$('terminal-shell').hidden=true;
// Keep the recorded 140 columns; adapt rows so only xterm scrolls vertically.
function fitTerminal(){
  const shell=$('terminal-shell');
  if(shell.hidden||typeof getComputedStyle!=='function')return;
  const screen=$('terminal').querySelector('.xterm-screen');
  const cell=screen?.getBoundingClientRect().height/terminal.rows;
  if(!Number.isFinite(cell)||cell<=0)return;
  const style=getComputedStyle(shell);
  const height=shell.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  if(height<=0)return;
  const rows=Math.max(2,Math.min(200,Math.floor(height/cell)));
  if(rows!==terminal.rows)terminal.resize(140,rows);
}
if(typeof ResizeObserver!=='undefined'){
  const observer=new ResizeObserver(fitTerminal);observer.observe($('terminal-shell'));
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
}
// The viewer never services clipboard/title/window commands originating in task output.
for(const code of [0,1,2,52])terminal.parser.registerOscHandler(code,()=>true);
let selected=null,selectedBatch=null,expandedBatch=null,revision='',generation=0,timer=null,refreshPending=false,ticking=false;
let selectionController=new AbortController(),preparationRequest=null;
let actionPending=false,actionNotice='',actionNoticeRun=null;
function refresh(){if(ticking){refreshPending=true;return;}clearTimeout(timer);void tick();}
const label={pending:'待处理',completed:'正常完成',timeout:'超时',cancelled:'已取消',failed:'未通过',passed:'通过',unavailable:'无法判定',complete:'已回收',retained:'现场保留'};
const limit=seconds=>seconds%60===0?seconds/60+' 分钟':seconds+' 秒';
const names={queued:'排队',preparing:'准备环境',running:'执行中',waiting_for_approval:'等待审批',verifying:'自动判题',passed:'通过',failed:'未通过',error:'运行异常',cancelled:'已取消',cancelling:'正在停止',needs_recovery:'收尾异常 · 待恢复',finished:'已结束',blocked:'调度暂停'};
const runLabel=run=>run.state==='error'&&run.execution==='completed'&&run.grading==='unavailable'?'判题异常 · 无法判定':names[run.displayState]||run.displayState;
const datasetNames={'deep-swe':'DeepSWE 1.1','terminal-bench-2.1':'Terminal-Bench 2.1','swe-bench-verified':'SWE-bench Verified'};
const runTitle=run=>(datasetNames[run.dataset]||run.dataset)+' · '+run.task;
async function api(path,body,signal){
  const requestSignal=body===undefined?AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]):undefined;
  const send=()=>fetch('/api/'+path,body===undefined?{signal:requestSignal}:{method:'POST',headers:{'X-Eval-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  let r=await send();
  if(r.status===403){await fetch('/',{signal:requestSignal});r=await send();}
  const x=await r.json();if(!r.ok)throw Error(x.error||'请求失败');return x;
}
function choose(id){if(selected===id)return;selectionController.abort();selectionController=new AbortController();preparationRequest=null;selected=id;revision='';generation++;terminal.reset();$('terminal-shell').hidden=true;$('terminal-empty').hidden=false;$('terminal-empty').textContent='正在读取任务记录…';$('preparation').textContent='正在读取执行与判题记录…';$('preparation-panel').open=false;}
function loadPreparation(run){
  if(preparationRequest)return;
  const current=generation,request={signal:selectionController.signal};preparationRequest=request;
  // Log I/O has its own single flight; it must never delay terminal polling.
  void api('preparation?run='+run.id,undefined,request.signal).then(prep=>{
    if(current!==generation)return;
    const text=[run.note,(prep.truncated?'（仅展示末尾日志，完整内容已保存）\n':'')+prep.text].filter(Boolean).join('\n\n');
    if($('preparation').textContent!==text)$('preparation').textContent=text||'暂无准备日志。';
  }).catch(error=>{
    if(current===generation&&!request.signal.aborted)$('preparation').textContent='记录读取失败，将自动重试：'+error.message;
  }).finally(()=>{if(preparationRequest===request)preparationRequest=null;});
}
function openAttempt(batchId,runId){selectedBatch=batchId;expandedBatch=batchId;choose(runId);refresh();}
async function actOnRun(id,action){
  if(actionPending)return;
  actionPending=true;actionNoticeRun=id;actionNotice=action==='retry-run'?'正在创建新的尝试…':'正在核验已有结果与现场…';
  $('run-action').disabled=true;$('action-message').hidden=false;$('action-message').textContent=actionNotice;
  try{
    const result=await api(action,{run:id});actionNotice='';
    if(action==='retry-run'&&selected===id)openAttempt(result.batch.id,result.batch.runIds[0]);
  }catch(error){actionNotice=error.message;}
  finally{actionPending=false;refresh();}
}
function button(title,meta,active,onclick){const b=document.createElement('button');b.className='run'+(active?' active':'');const t=document.createElement('b');t.textContent=title;const m=document.createElement('small');m.textContent=meta;b.append(t,m);b.onclick=onclick;return b;}
function cards(values){return values.map(([name,value])=>{const card=document.createElement('div');const number=document.createElement('strong');number.textContent=value;const text=document.createElement('span');text.textContent=name;card.append(number,text);return card;});}
async function tick(){if(ticking)return;ticking=true;try{
  const requestedGeneration=generation,data=await api('status',undefined,selectionController.signal);if(requestedGeneration!==generation){refreshPending=true;return;}$('connection').textContent=data.workerConnected===false?'执行服务状态未确认 · 显示已保存进度':data.schedulingBlocked?'调度暂停 · 请检查异常记录':'已连接 · 并发上限 '+data.concurrency;const blocked=data.runs.filter(r=>r.state==='needs_recovery');$('error').textContent=data.schedulingBlocked?(blocked.length?'调度暂停：'+blocked.map(runTitle).join('、')+' 的执行或收尾尚未确认。运行中的任务继续，新任务暂不启动。'+(blocked[0].note?' 原因：'+blocked[0].note.slice(-700):''):'调度暂停：状态保存或回收失败，请检查服务日志。'):'';
  if(!data.batches.some(b=>b.id===selectedBatch)){selectedBatch=data.batches[0]?.id||null;expandedBatch=selectedBatch;choose(null);}
  if(expandedBatch&&!data.batches.some(b=>b.id===expandedBatch))expandedBatch=null;
  const batch=data.batches.find(b=>b.id===selectedBatch);
  if(batch){
    $('batch-title').textContent=batch.name;
    $('batch-detail').textContent=batch.id+' · '+batch.model.model+' · 并发 '+batch.concurrency+' · '+'各题独立时限'+' · 版本 '+String(batch.payload.commit||'未知').slice(0,8)+(batch.payload.worktree_overlay?.length?'（含工作区改动）':'');
    const c=batch.counts;$('summary').replaceChildren(...cards([['已完成',c.completed+'/'+c.total],['运行中',c.active],['排队',c.queued],['通过',c.passed],['未通过',c.failed],['异常',c.errors],['取消',c.cancelled]]));
    const runs=data.runs.filter(r=>r.batchId===batch.id);
    if(!runs.some(r=>r.id===selected))choose(runs.find(r=>['running','preparing'].includes(r.displayState))?.id||runs[0]?.id||null);
  }else{
    $('batch-title').textContent='还没有评测批次';$('batch-detail').textContent='提交题目清单后，在这里查看执行过程和判题结果。';
    $('summary').replaceChildren();$('title').textContent='选择任务查看执行过程';$('detail').textContent='';$('statuses').replaceChildren();$('terminal-status').textContent='';$('attach').textContent='';$('preparation').textContent='尚未开始。';$('terminal-empty').textContent='提交批次后，任务会依次运行并自动判题。';
    $('run-action').hidden=true;$('previous-attempt').hidden=true;$('action-message').hidden=true;
  }
  $('batches').replaceChildren(...data.batches.map(b=>{
    const group=document.createElement('div');
    const expanded=b.id===expandedBatch;
    const heading=button(b.name,new Date(b.createdAt*1000).toLocaleString()+' · '+b.counts.completed+'/'+b.counts.total+' · '+names[b.state],b.id===selectedBatch,()=>{
      if(expandedBatch===b.id)expandedBatch=null;
      else{expandedBatch=b.id;if(selectedBatch!==b.id){selectedBatch=b.id;choose(null);}}
      refresh();
    });
    heading.className+=' batch-toggle';heading.setAttribute('aria-expanded',String(expanded));
    group.append(heading);
    if(expanded){
      const tasks=document.createElement('div');tasks.className='task-tree';
      tasks.append(...data.runs.filter(r=>r.batchId===b.id).map(r=>button(runTitle(r),runLabel(r)+' · '+limit(r.budget.agentSeconds)+' 上限',r.id===selected,()=>{choose(r.id);refresh();})));
      group.append(tasks);
    }
    return group;
  }));
  const run=data.runs.find(r=>r.id===selected);
  if(run){
    const finished=['passed','failed','error','cancelled','needs_recovery'].includes(run.state);
    const child=data.batches.find(b=>b.retryOf?.runId===run.id),recovery=run.state==='needs_recovery';
    $('run-action').hidden=run.state==='passed'||(!finished&&!child);$('run-action').disabled=actionPending||(!child&&!recovery&&data.schedulingBlocked);
    $('run-action').textContent=child?'查看重跑任务':recovery?'恢复结果':'重新运行';
    $('run-action').title=child?'打开已创建的尝试':recovery?'核验已有证据，不再次调用模型':'保留原记录，沿用原题、模型和预算开始新的模型执行';
    $('run-action').onclick=()=>child?openAttempt(child.id,child.runIds[0]):actOnRun(run.id,recovery?'recover-run':'retry-run');
    const previous=batch.retryOf&&data.runs.find(r=>r.id===batch.retryOf.runId);
    $('previous-attempt').hidden=!previous;$('previous-attempt').onclick=()=>{if(previous)openAttempt(previous.batchId,previous.id);};
    $('action-message').hidden=actionNoticeRun!==run.id||!actionNotice;$('action-message').textContent=actionNoticeRun===run.id?actionNotice:'';
    $('terminal-status').textContent=run.state==='needs_recovery'?'收尾异常，等待核验已有结果与现场':finished?'任务已结束 · 判题'+(label[run.grading]||run.grading)+' · 下方为保存的终端画面':run.state==='verifying'?'Agent 已停止作答，正在自动判题。':'终端实时更新';
    $('attach').textContent='证据目录：'+run.evidencePath+'\n'+(finished?'任务已结束；当前显示保存的终端内容。':run.container?.attach||'容器尚未启动');
    $('title').textContent=runTitle(run);$('detail').textContent=run.id+' · '+(batch.retryOf?'第 '+batch.retryOf.attempt+' 次尝试 · ':'')+limit(run.budget.agentSeconds)+' 上限 · '+(runLabel(run)||'正在准备');
    $('statuses').replaceChildren(...[['执行',run.execution],['判题',run.grading],['数据',run.collection]].map(([name,value])=>{const e=document.createElement('span');e.textContent=name+' · '+(label[value]||value);e.dataset.state=value;return e;}));
    $('preparation-title').textContent='执行与判题记录 · '+(run.preparation?.phase||'等待开始');
    if($('terminal-shell').hidden){$('terminal-empty').textContent=run.state==='queued'?(data.schedulingBlocked?'调度暂停，需先处理异常任务；当前排队与并发名额无关。':'正在排队，前面的任务结束后自动开始。'):run.state==='preparing'?'正在准备工作目录和运行环境。':finished?(run.note?'没有保存的终端画面。\n\n'+run.note:'没有保存的终端画面，可展开证据目录检查日志。'):'等待终端输出…';}
    const current=generation, id=selected;
    loadPreparation(run);
    const packet=await api('terminal?run='+id+'&revision='+encodeURIComponent(revision),undefined,selectionController.signal);
    if(current===generation&&packet.screen!==undefined){
      const old=terminal.buffer.active;const bottom=old.viewportY>=old.baseY;const scroll=old.viewportY;
      const visible=Boolean(packet.screen.trim());$('terminal-shell').hidden=!visible;$('terminal-empty').hidden=visible;fitTerminal();
      if(!visible&&finished)$('terminal-status').textContent='任务已结束 · 没有保存的终端画面';
      terminal.reset();
      await new Promise(resolve=>terminal.write(packet.screen.replace(/\r?\n/g,'\r\n'),resolve));
      if(current===generation){revision=packet.revision;if(bottom)terminal.scrollToBottom();else terminal.scrollToLine(scroll);if(visible)terminal.refresh(0,terminal.rows-1);}
    }
  }
}catch(e){if(e.name!=='AbortError'){$('connection').textContent='连接暂不可用';$('error').textContent=e.name==='TimeoutError'?'读取超时，将自动重试。':e.message;}}finally{ticking=false;if(refreshPending){refreshPending=false;void tick();}else timer=setTimeout(tick,1000);}}
tick();
