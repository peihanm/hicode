"""Execute one assignment inside its disposable container and prepared environment."""
import base64,fcntl,json,os,pwd,signal,subprocess,sys,time
from pathlib import Path
from protocol import assignment_prompt,Events,atomic_json,namespace_argv,wait_verifier_handoff
from terminal import capture,settle,submit_prompt
from cleanup import stop_task_processes,finalize_task,open_task_cli,terminate_task_cli,process_start
from model_proxy import Gateway
from dataset_runtime import dataset_runtime

run_id=sys.argv[1]
if len(run_id)!=16 or any(c not in '0123456789abcdef' for c in run_id):raise ValueError('Invalid run ID')
root=Path('/eval/runs')/run_id
config=json.loads((root/'job.json').read_text())
network=config.get('network')
if network not in {'open','isolated'}:raise ValueError('Invalid evaluation network mode')
dataset=dataset_runtime(config)
service_declaration=None
if config.get('service') is not None:
    from service_namespace import ServiceNamespace,service_paths
    service_declaration=service_paths(config)
service=None
project=root/'project';home=root/'home';logs=root/'logs';actor_events=root/'actor-events';event_path=actor_events/'events.jsonl';control=Path('/run/hicode-eval')/run_id
name='eval-'+run_id
cancelled=False

def emit(kind,**value):
    print(json.dumps({'type':kind,**value},ensure_ascii=False),flush=True)

def interrupt(*_):
    global cancelled
    cancelled=True
signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)

with open('/eval/users.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    try:pwd.getpwnam(name)
    except KeyError:pass
    else:raise ValueError('Run user already exists; attempts cannot be resumed')
    uid=20000
    try:pwd.getpwuid(uid)
    except KeyError:pass
    else:raise ValueError('A fresh run container is required')
    subprocess.run(['useradd','--uid',str(uid),'--user-group','--no-create-home','--shell','/bin/bash',name],check=True)
    account=pwd.getpwnam(name)
for p in [root,project,home,logs,actor_events,control]:p.mkdir(parents=True,exist_ok=True)
subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(project),str(home),str(logs),str(actor_events),str(control)],check=True)
if config.get('publicTestInputs'):
    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(root/'public-tests')],check=True)
os.chown(root,uid,account.pw_gid);os.chmod(root,0o700)
for p in [project,home,logs,actor_events,control]:os.chmod(p,0o700)
atomic_json(root/'identity.json',{'version':2,'uid':uid,'user':name,'pid':os.getpid(),'runnerStart':process_start(os.getpid()),'run':run_id})

def demote():
    os.setgroups([]);os.setgid(account.pw_gid);os.setuid(uid)

def namespace(args,verifier=False,setup=False,actor=False):
    if service is not None and actor:return service.actor_argv(args)
    if service is not None and verifier:
        def view(arguments):
            argv=namespace_argv(arguments,project,home,logs,control,root/'tests',workdir=dataset.workdir,
                                writable_tests=dataset.writable_tests(config),verifier_release=config['release'])
            runtime=[]
            for path in ['/opt/hicode-verifier','/opt/hicode-terminal/verifier']:
                if Path(path).exists():runtime+=['--ro-bind',path,path]
            return argv[:-len(arguments)]+runtime+arguments
        return service.verifier_argv(args,view)
    return namespace_argv(args,project,home,logs,control,root/'tests' if verifier else None,
                          writable_tests=verifier and dataset.writable_tests(config),
                          root_overlay=verifier and not setup and config.get('verifierRootOverlay',False),
                          workdir=dataset.workdir,environment=dataset.actor_environment,
                          workspace_aliases=dataset.workspace_aliases(config),
                          writable_runtime_bin=dataset.writable_runtime_bin(config),
                          public_tests=root/'public-tests' if not verifier and config.get('publicTestInputs') else None,
                          private_root=dataset.verifier_root if verifier else None,
                          isolated_network=actor and network=='isolated',
                          actor_release=config['release'] if actor else None,actor_events=actor_events if actor else None,
                          model_gateway=actor and gateway is not None)

def command(args,timeout=15,extra=None,cwd=None,output_path=None):
    env={'PATH':'/opt/python313/bin:'+str(home/'.local/bin')+':'+str(home/'bin')+':'+os.environ['PATH'],'HOME':str(home),'TERM':'xterm-256color','COLORTERM':'truecolor','LANG':'C.UTF-8'}
    env.update(dataset.command_environment(config,home,root))
    env.update(config.get('environment',{}))
    if extra:env.update(extra)
    r=subprocess.run(args,cwd=cwd or project,env=env,preexec_fn=None if service is not None else demote,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
    if output_path is not None:output_path.write_text(r.stdout+'\n'+r.stderr)
    if r.returncode:raise RuntimeError((r.stderr or r.stdout or 'Command failed')[-2000:])
    return r.stdout

socket=str(control/'tmux.sock')
def tmux(*args,**kwargs):return command(['tmux','-S',socket,*args],**kwargs)

def stop_user():
    stop_task_processes(uid)

terminal_started=False;cli_fd=None;shutdown_attempted=False;shutdown_receipt=None;agent_failed=False;gateway=None
model=config['model'];release=config['release'];status='failed';grade='unavailable';events=Events();offset=0

def drain_events():
    global offset
    if event_path.exists():
        if event_path.is_symlink():raise ValueError('Event file replaced with symlink')
        with event_path.open('rb') as f:f.seek(offset);data=f.read(256*1024)
        offset+=len(data)
        if data:events.accept(data);emit('events',data=base64.b64encode(data).decode())
        return bool(data)
    return False

def shutdown_cli():
    global shutdown_attempted,shutdown_receipt
    if shutdown_attempted:return shutdown_receipt
    if cli_fd is None:return None
    shutdown_attempted=True
    emit('phase',phase='Stopping HiCode: '+status)
    started=time.monotonic();exited=False;error=None
    try:exited=terminate_task_cli(cli_fd,drain_events)
    except (OSError,RuntimeError,ValueError) as exc:error=str(exc)[-2000:]
    receipt={'version':1,'reason':status,'graceSeconds':10,'elapsedSeconds':round(time.monotonic()-started,3),
        'cliExited':exited,'turnSaved':events.ending is not None and events.ending.get('persistence_status')=='saved',
        'pendingToolCallIds':sorted(events.pending_tools),'eventStreamComplete':not bool(events.partial.strip()),'error':error}
    shutdown_receipt=receipt
    atomic_json(root/'shutdown.json',receipt)
    if error or not exited:emit('error',message='Graceful shutdown incomplete; forcing task cleanup. '+(error or 'CLI did not exit within 10 seconds.'))
    elif events.started and (not receipt['turnSaved'] or receipt['pendingToolCallIds'] or not receipt['eventStreamComplete']):
        emit('error',message='CLI exited, but execution records did not close completely; see shutdown.json.')
    return receipt

try:
    # Approval is granted for this disposable assignment, inside the outer namespace.
    config['permissionMode']='full-access'
    atomic_json(root/'job.json',config)
    emit('phase',phase='Deploying task in its isolated container')
    settings={'sources':{model['source']:{'baseUrl':model['baseUrl'],'apiKeyEnv':model['apiKeyEnv'],'models':[{'id':model['model'],'label':model['model'],'imageInput':model.get('imageInput',False)}]}},'models':{'primary':{'source':model['source'],'model':model['model']}},'memory':{'enabled':False},'permissions':{'defaultMode':config['permissionMode'],'deny':[f'{t}({p}/**)' for t in ['write_file','edit_file'] for p in [str(logs),str(actor_events),str(control)]]},'sandbox':{'network':{'mode':'open'},'filesystem':{'denyWrite':[str(logs),str(actor_events),str(control)]}}}
    if model.get('reasoning') is not None:
        settings['models']['reasoning']=[{'source':model['source'],'model':model['model'],'effort':model['reasoning']['effort']}]
    if network=='isolated':settings['permissions']['deny'].append('web_fetch')
    conf=home/'.hicode';conf.mkdir(exist_ok=True);atomic_json(conf/'settings.json',settings)
    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(home)],check=True)
    extra={'HICODE_EVAL_SOURCE':release,'HICODE_EVAL_HOME':str(conf)}
    dataset.prepare_actor(config,project,logs,command,namespace)
    command(namespace(['bun','/opt/hicode-eval/preflight.ts'],actor=True),timeout=60,extra=extra)
    if network=='isolated':
        # Check the actual actor namespace before consuming model tokens. There is no open fallback.
        command(namespace(['python3','-c',"import socket; assert [n for _,n in socket.if_nameindex()] == ['lo']"],actor=True),timeout=15)
    gateway=Gateway(control/'model.sock',model['baseUrl'],model['model'],os.environ[model['apiKeyEnv']],config['reasoningPolicy'])
    os.chown(control/'model.sock',uid,account.pw_gid)
    if service_declaration is not None:
        owner=ServiceNamespace(root,uid,service_declaration,network=network)
        owner.prepare()
        try:
            owner.start(lambda args:namespace(args,actor=True),
                        {'PATH':'/opt/python313/bin:'+os.environ['PATH'],'HOME':str(home),'SHELL':'/bin/bash','LANG':'C.UTF-8'},
                        model_socket=control/'model.sock' if gateway else None)
        except BaseException:
            owner.close();raise
        service=owner
        extra['HICODE_LINUX_RUNTIME_DIR']=str(owner.sandbox_runtime)
        command(namespace(['bun','/opt/hicode-eval/preflight.ts'],actor=True),timeout=60,extra=extra)
    atomic_json(root/'network.json',{'version':1,'mode':network,'actorInternet':network=='open',
                                   'modelTransport':'unix-model-gateway' if gateway else 'direct'})
    emit('phase',phase='Starting HiCode')
    launch=control/'launch.sh'
    import shlex
    actor_command=['bun',release+'/src/index.tsx','--single-task','--event-log',str(event_path),'--permission-mode',config['permissionMode'],'--source',model['source'],'--model',model['model']]
    if gateway:actor_command=['python3','/opt/hicode-eval/network_entry.py',str(control/'model.sock'),str(conf/'settings.json'),*actor_command]
    launch.write_text('#!/bin/bash\nset -eu\nexec '+shlex.join(namespace(actor_command,actor=True))+'\n')
    launch.chmod(0o755)
    secret={model['apiKeyEnv']:'eval-isolated' if gateway else os.environ[model['apiKeyEnv']]}
    if service is not None:secret['HICODE_LINUX_RUNTIME_DIR']=str(service.sandbox_runtime)
    tmux('new-session','-d','-s','hicode','-x','140','-y','40','bash --noprofile --norc',extra=secret)
    terminal_started=True
    tmux('set-option','-t','hicode','remain-on-exit','on')
    tmux('set-option','-t','hicode','history-limit','20000')
    tmux('pipe-pane','-O','-t','hicode:0.0',shlex.join(['python3','/opt/hicode-eval/record.py',str(logs/'terminal.bin')]))
    tmux('send-keys','-t','hicode:0.0','-l','exec bash '+shlex.quote(str(launch)));tmux('send-keys','-t','hicode:0.0','Enter')
    startup=time.monotonic();start=None;submitted=None;last_screen=0;old_screen=None
    while start is None or time.monotonic()-start<config['agentSeconds']:
        if (logs/'terminal.overflow').exists():raise RuntimeError('Terminal recording exceeds limit')
        if cancelled or (root/'cancel').exists():status='cancelled';break
        drain_events()
        if time.monotonic()-last_screen>=1:
            screen=tmux('capture-pane','-p','-e','-S','-20000','-t','hicode:0.0')
            if len(screen.encode())>8*1024*1024:raise ValueError('Terminal exceeds budget')
            if screen!=old_screen:emit('screen',screen=screen);old_screen=screen
            last_screen=time.monotonic()
        if events.started and start is None:
            start=time.monotonic()
            emit('phase',phase='Running HiCode')
        if events.ready and submitted is None:
            cli_fd=open_task_cli(uid,release+'/src/index.tsx',event_path)
            instruction=(root/'instruction.md').read_text()
            instruction=assignment_prompt(instruction,config['agentSeconds'],network,dataset.workdir,dataset.public_test_entries(config))
            (root/'submitted-instruction.md').write_text(instruction)
            prompt=control/'prompt.txt';prompt.write_text(instruction);prompt.chmod(0o644)
            if not submit_prompt(tmux,prompt,lambda:cancelled or (root/'cancel').exists()):
                status='cancelled';break
            submitted=time.monotonic()
        if events.failed_turn():
            status='failed';agent_failed=True
            emit('error',message='HiCode turn failed; stopping this attempt without waiting for its time budget.')
            break
        if events.complete():
            if events.settled['reason']!='completed':raise RuntimeError('Agent stopped: '+events.settled['reason'])
            status='completed';break
        if submitted is None and time.monotonic()-startup>40:raise RuntimeError('TUI ready event missing')
        if submitted is not None and not events.started and time.monotonic()-submitted>15:raise RuntimeError('Prompt submission was not acknowledged; no model request started')
        if tmux('display-message','-p','-t','hicode:0.0','#{pane_dead}').strip()=='1':raise RuntimeError('HiCode exited before completion')
        time.sleep(.5)
    else:status='timeout'
    if status in ['timeout','cancelled'] or agent_failed:
        receipt=shutdown_cli()
        if agent_failed and (receipt is None or receipt['error'] or not receipt['cliExited'] or not receipt['turnSaved']
                             or receipt['pendingToolCallIds'] or not receipt['eventStreamComplete']):
            raise RuntimeError('Failed HiCode turn did not close its execution records; verification withheld. See shutdown.json.')
    if terminal_started:
        try:
            if status=='completed':
                if not settle(tmux,emit,lambda:cancelled or (root/'cancel').exists()):
                    emit('error',message='Final terminal paint did not stabilize before the capture deadline; execution and grading are recorded separately.')
            else:capture(tmux,emit)
        except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
            emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    if status in ['completed','timeout'] or agent_failed:
        # A completed single-task turn is sealed, but its Runtime still owns
        # live Shell services. Keep that owner until the private verifier ends.
        if service is not None:
            if status=='completed':
                drain_events()
                if not events.complete() or events.settled['reason']!='completed':
                    raise RuntimeError('Service handoff requires sealed Agent execution')
            else:
                receipt=shutdown_cli()
                if receipt is None or not receipt['cliExited'] or receipt['error'] or receipt['pendingToolCallIds'] or not receipt['eventStreamComplete']:
                    raise RuntimeError('Service handoff requires confirmed Agent shutdown')
                tmux('kill-server');terminal_started=False
        else:stop_user();terminal_started=False
        if gateway:gateway.close();gateway=None
        emit('phase',phase='Awaiting local verification')
        # Host uploads checks only after the assignment is sealed.
        emit('verification_request',runId=run_id)
        if not wait_verifier_handoff(root,run_id,lambda:cancelled or (root/'cancel').exists()):status='cancelled'
        if status in ['completed','timeout'] or (agent_failed and status=='failed'):
            emit('phase',phase='Verifying result')
            try:
                verifier_log=logs/'verifier'
                if verifier_log.is_symlink():raise ValueError('Verifier log directory replaced with symlink')
                verifier_log.mkdir(exist_ok=True);os.chown(verifier_log,uid,account.pw_gid)
                grade,output=dataset.grade(root=root,config=config,uid=uid,gid=account.pw_gid,project=project,
                                           home=home,logs=logs,command=command,namespace=namespace,
                                           demote=None if service is not None else demote,cancelled=lambda:cancelled or (root/'cancel').exists())
            except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as e:
                output='Verifier setup failed: '+str(e);grade='unavailable'
                (verifier_log/'output.txt').write_text(output)
            if cancelled or (root/'cancel').exists():status='cancelled';grade='unavailable'
            if grade in ['passed','failed']:
                (verifier_log/'reward.txt').write_text('1\n' if grade=='passed' else '0\n')
            emit('verification',text=output)
            if grade=='unavailable':emit('error',message=output[-2000:])
except BaseException as error:
    if cancelled or (root/'cancel').exists():status='cancelled'
    emit('error',message=str(error)[-2000:])
finally:
    try:
        try:
            if terminal_started:shutdown_cli()
        except (OSError,RuntimeError,ValueError) as error:
            emit('error',message='Could not finish graceful shutdown: '+str(error)[-1000:])
        # Keep the final cancellation frame, independently of live sampling.
        if terminal_started:
            try:capture(tmux,emit)
            except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
                emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    finally:
        # Even a broken output pipe or failed shutdown receipt must clean the UID.
        result={'execution':status,'grading':grade,'uid':uid}
        try:
            if service is not None:
                try:service.snapshot()
                finally:
                    service.close()
                    try:tmux('kill-server')
                    except (OSError,RuntimeError,subprocess.SubprocessError):pass
            finalize_task(root,result)
        finally:
            if gateway:gateway.close()
            if cli_fd is not None:os.close(cli_fd)
    emit('result',**result)
