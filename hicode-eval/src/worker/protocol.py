import hashlib
import json
import os
import re
import shutil
import stat
import time
from pathlib import Path


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def wait_verifier_handoff(root, run_id, cancelled):
    """Host ACK and upload share one bounded, run-scoped handoff after sealing."""
    started = time.monotonic()
    accepted = False
    path = Path(root) / 'verification.json'
    while True:
        if cancelled():return False
        elapsed=time.monotonic()-started
        if not accepted and elapsed >= 30:raise RuntimeError('Verifier handoff acknowledgement timed out')
        if elapsed >= 180:raise RuntimeError('Verifier handoff upload timed out')
        if path.is_symlink():raise ValueError('Invalid verifier handoff file')
        if path.exists():
            if not path.is_file() or path.stat().st_size > 4096:raise ValueError('Invalid verifier handoff size/type')
            value = json.loads(path.read_text())
            if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                    or value.get('runId') != run_id or value.get('status') not in {'accepted', 'ready', 'failed'}):
                raise ValueError('Invalid verifier handoff identity/state')
            if value['status'] == 'failed':
                message=value.get('message')
                if not isinstance(message,str) or len(message)>1500:raise ValueError('Invalid verifier handoff failure')
                raise RuntimeError('Verifier upload failed: '+message)
            if value['status'] == 'ready':return True
            accepted = True
        time.sleep(.2)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()



class Events:
    def __init__(self):
        self.partial = b''
        self.sequence = 0
        self.ready = False
        self.started = False
        self.busy = False
        self.waiting = False
        self.settled = None
        self.ending = None
        self.last_type = None
        self.session_id = None
        self.pending_tools = set()

    def accept(self, data):
        self.partial += data
        if len(self.partial) > 8 * 1024 * 1024:
            raise ValueError('Event record exceeds its budget')
        lines = self.partial.split(b'\n')
        self.partial = lines.pop()
        for raw in lines:
            if not raw:
                continue
            event = json.loads(raw)
            if not isinstance(event,dict) or type(event.get('version')) is not int or event.get('version') != 1 or type(event.get('sequence')) is not int or event.get('sequence') != self.sequence + 1:
                raise ValueError('Event sequence gap; refusing to infer completion')
            session_id=event.get('sessionId')
            if not isinstance(session_id,str) or not 0<len(session_id)<=256 or any(ord(c)<32 for c in session_id):
                raise ValueError('Invalid session identity in event export')
            if self.session_id is not None and session_id!=self.session_id:raise ValueError('Mixed sessions in one event stream')
            self.session_id=session_id
            self.sequence += 1
            kind = event['type']
            if kind not in {'ready','state','settled','agent_event'}:raise ValueError('Unknown interactive event')
            if kind=='state' and any(type(event.get(k)) is not bool for k in ['busy','waitingForApproval']):raise ValueError('Invalid UI state')
            if kind=='settled':
                if type(event.get('sealed')) is not bool:raise ValueError('Missing execution seal state')
                if any(type(event.get(k)) is not int or event[k]<0 for k in ['runningAgents','pendingAgentMessages']):raise ValueError('Invalid Agent completion counters')
                if event.get('reason') not in {'completed','incomplete','max_turns','permission_denied','hook_blocked','hook_error','hook_limit','no_tool_calls','interrupted','shutdown','error'}:raise ValueError('Unknown stop reason')
            if kind=='agent_event' and (not isinstance(event.get('event'),dict) or not isinstance(event['event'].get('type'),str)):
                raise ValueError('Invalid Agent event')
            if kind == 'ready': self.ready = True
            elif kind == 'state':
                if event['busy'] and not self.busy:
                    self.settled = None; self.ending = None
                self.busy = event['busy']
                self.waiting = event['waitingForApproval']
            elif kind == 'settled': self.settled = event
            elif kind == 'agent_event':
                self.last_type = event['event']['type']
                if self.last_type == 'model_stream_start': self.started = True; self.settled = None; self.ending = None
                if self.last_type == 'turn_end': self.ending = event['event']['input']
                if self.last_type in {'tool_call_start', 'tool_call_end'}:
                    tool_id = event['event'].get('toolCallId')
                    if not isinstance(tool_id, str) or not tool_id:
                        raise ValueError('Missing tool call identity')
                    if self.last_type == 'tool_call_start':
                        if tool_id in self.pending_tools: raise ValueError('Duplicate tool call start')
                        self.pending_tools.add(tool_id)
                    else:
                        if tool_id not in self.pending_tools: raise ValueError('Unpaired tool call result')
                        self.pending_tools.remove(tool_id)

    def complete(self):
        return (self.settled is not None and self.settled.get('sealed') is True and not self.busy and self.settled['runningAgents'] == 0 and self.settled.get('pendingAgentMessages') == 0
                and not self.pending_tools and self.ending is not None and self.ending['persistence_status'] == 'saved')

    def failed_turn(self):
        # An exported Root failure is a stop request, not an execution seal.
        # The runner must terminate and confirm cleanup before exposing tests.
        return (self.started and not self.busy and not self.waiting and not self.partial.strip()
                and isinstance(self.ending, dict) and self.ending.get('status') == 'failed'
                and self.ending.get('session_id') == self.session_id
                and self.ending.get('reason') == 'error'
                and self.ending.get('persistence_status') in {'saved', 'failed'})


def prepare_verifier_root(project, target):
    """A sealed copy on one mount lets original /app -> /tmp renames work."""
    project, target = Path(project), Path(target)
    if project.is_symlink() or not project.is_dir():raise ValueError('Invalid sealed project')
    target.mkdir(mode=0o700)
    total=0;count=0
    def copy_tree(source, destination):
        nonlocal total,count
        destination.mkdir()
        for entry in sorted(os.scandir(source),key=lambda e:e.name):
            count+=1
            if count>20000:raise ValueError('Verifier file budget exceeded')
            out=destination/entry.name;mode=entry.stat(follow_symlinks=False).st_mode
            if stat.S_ISLNK(mode):
                resolved=Path(entry.path).resolve()
                if not resolved.is_relative_to(project.resolve()):raise ValueError('Verifier link escapes project')
                out.symlink_to(os.readlink(entry.path))
            elif stat.S_ISDIR(mode):copy_tree(Path(entry.path),out)
            elif stat.S_ISREG(mode):
                total+=entry.stat(follow_symlinks=False).st_size
                if total>512*1024*1024:raise ValueError('Verifier byte budget exceeded')
                shutil.copy2(entry.path,out,follow_symlinks=False)
            else:raise ValueError('Special verifier input')
    copy_tree(project,target/'app');(target/'tmp').mkdir(mode=0o700)



def actor_readonly_mounts(release, environment):
    """Expose system/runtime inputs, never the evaluation machine's root."""
    release=Path(release)
    if not re.fullmatch(r'/opt/hicode/releases/[a-f0-9]{64}',str(release)) or release.is_symlink() or not release.is_dir():
        raise ValueError('Invalid actor source release')
    paths=[]
    for name in ['/usr','/bin','/sbin','/lib','/lib64']:
        path=Path(name)
        if path.exists():
            if path.is_symlink() and not path.resolve().is_relative_to(Path('/usr')):
                raise ValueError('System tool link escapes allowed runtime')
            paths.append(path)
    for name in ['/etc/passwd','/etc/group','/etc/nsswitch.conf','/etc/hosts','/etc/hostname',
                 '/etc/resolv.conf','/etc/localtime','/etc/locale.alias','/etc/ld.so.cache',
                 '/etc/alternatives','/etc/ssl/certs','/etc/ssl/openssl.cnf',
                 '/etc/fonts','/etc/chromium.d','/etc/ImageMagick-6','/etc/R','/etc/texmf','/var/lib/texmf',
                 '/etc/python3.11', '/etc/ocamlfind.conf','/etc/ocamlfind.conf.d', '/opt/python313','/opt/hicode-task','/build']:
        path=Path(name)
        if path.exists():paths.append(path)
    dependencies=(release/'node_modules').resolve(strict=True)
    if not (dependencies==Path('/opt/hicode/node_modules') or
            re.fullmatch(r'/opt/hicode/dependencies/[a-f0-9]{64}/node_modules',str(dependencies))):
        raise ValueError('Actor dependencies escape prepared runtime')
    paths.extend([release,dependencies,Path('/opt/hicode-eval/preflight.ts'),Path('/opt/hicode-eval/network_entry.py')])
    terminal_packages=Path('/opt/hicode-terminal/actor')
    if terminal_packages.exists():
        if terminal_packages.is_symlink() or not terminal_packages.is_dir():
            raise ValueError('Invalid prepared terminal actor packages')
        paths.append(terminal_packages)
    virtualenv=Path('/opt/venv')
    if virtualenv.is_symlink() or virtualenv.exists():
        if virtualenv.is_symlink() or not virtualenv.is_dir() or virtualenv.resolve()!=virtualenv:
            raise ValueError('Invalid prepared virtual environment')
        paths.append(virtualenv)
    if environment is not None:
        interpreter=(Path(environment)/'bin/python').resolve(strict=True)
        if not interpreter.is_relative_to(Path('/usr')):
            runtime=interpreter.parent.parent
            if runtime.parent!=Path('/opt/hicode-swe/python') or not runtime.name.startswith('cpython-'):
                raise ValueError('Actor interpreter escapes prepared runtime')
            paths.append(runtime)
            if runtime.name=='cpython-3.6.15-source':paths.append(Path('/opt/hicode-swe/python/openssl-1.1.1w/lib'))
    result=[]
    for path in dict.fromkeys(paths):
        if not path.exists():raise ValueError('Missing required actor runtime: '+str(path))
        result+=['--ro-bind',str(path),str(path)]
    return result


def assignment_prompt(instruction, agent_seconds, network, workdir, public_entries):
    if type(agent_seconds) is not int or not 30<=agent_seconds<=10800:raise ValueError('Invalid assignment time limit')
    if network not in {'open','isolated'} or workdir not in {'/app','/testbed'}:raise ValueError('Invalid assignment environment')
    minutes,seconds=divmod(agent_seconds,60)
    duration=(str(minutes)+' 分钟' if minutes else '')+(' '+str(seconds)+' 秒' if seconds else '')
    lines=['[评测环境说明]',f'本题最多执行 {duration.strip()}。完成必要修复和验证后即可交付，无需跑满时限。',
           '本题工作区：'+workdir+'。',
           '公开测试入口：'+('、'.join(public_entries) if public_entries else '未提供额外挂载；可使用工作区已有的公开测试与自测')+'。',
           '仅提供本题文件、必要运行工具和已准备依赖；其他题目、准备缓存和隐藏验收不向做题进程提供。']
    if network=='isolated':lines.append('当前外网不可用，请使用提供的工作区、已准备依赖和公开测试；模型连接由评测系统单独管理。')
    else:lines.append('模型连接由评测系统管理。')
    return '\n'.join(lines)+'\n\n'+instruction


def namespace_argv(args, project, home, logs, control, tests=None, *, writable_tests=False, root_overlay=False, workdir="/app", environment=None, readonly_logs=False, public_tests=None, private_root=None, isolated_network=False, actor_release=None, actor_events=None, workspace_aliases=(), writable_runtime_bin=False, verifier_release=None, model_gateway=False):
    if type(model_gateway) is not bool or (model_gateway and (actor_release is None or not isolated_network)):
        raise ValueError('Model gateway requires an isolated actor')
    if verifier_release is not None and (tests is None or actor_release is not None or public_tests is not None or root_overlay or private_root is not None):
        raise ValueError('Minimal verifier view requires a separate verifier workspace')
    if type(writable_runtime_bin) is not bool or (writable_runtime_bin and workdir!='/app'):
        raise ValueError('Invalid runtime executable view')
    aliases={'/data':'/app/data','/workspace':'/app','/tmp/CompCert':'/app/CompCert'}
    if not isinstance(workspace_aliases, (list, tuple)) or any(not isinstance(path,str) or path not in aliases for path in workspace_aliases):
        raise ValueError('Unsupported workspace alias')
    if len(set(workspace_aliases))!=len(workspace_aliases) or (workspace_aliases and workdir!='/app'):
        raise ValueError('Invalid workspace aliases')
    if (actor_release is None)!=(actor_events is None):raise ValueError('Actor release and event storage must be paired')
    if actor_release is not None and (tests is not None or root_overlay or readonly_logs):raise ValueError('Actor and verifier views cannot be combined')
    if tests is None and (writable_tests or root_overlay):raise ValueError('Verifier-only filesystem options')
    if private_root is not None and (tests is None or not root_overlay or workdir!='/app'):raise ValueError('Private chroot is verifier-only')
    if public_tests is not None and tests is not None:raise ValueError('Public helpers and hidden verifier are separate views')
    result=['bwrap','--unshare-user','--unshare-pid','--die-with-parent']
    if isolated_network:result+=['--unshare-net']
    if actor_release is not None or verifier_release is not None:
        result+=['--tmpfs','/',*actor_readonly_mounts(actor_release if actor_release is not None else verifier_release,environment),'--dir','/run','--dir','/var','--dir','/var/tmp']
    elif root_overlay or workspace_aliases:
        # A verifier may create new top-level directories in a private tmpfs;
        # every existing system entry remains read-only. The host root is never writable.
        result+=['--bind',str(private_root),'/','--uid','0','--gid','0','--cap-add','CAP_SYS_CHROOT'] if private_root is not None else ['--tmpfs','/']
        alias_roots={path[1:] for path in workspace_aliases if path.count('/')==1}
        for name in sorted(os.listdir('/')):
            if name not in {'proc','dev','tmp','app','tests','logs','testbed','server'} | alias_roots:result+=['--ro-bind','/'+name,'/'+name]
    else:result+=['--ro-bind','/','/']
    if workdir not in {'/app','/testbed'}:raise ValueError('Unsupported dataset workspace')
    result+=['--proc','/proc','--dev','/dev']
    if isolated_network:result+=['--tmpfs','/run']
    if private_root is None:result+=['--tmpfs','/tmp','--bind',str(project),workdir]
    # Original task paths refer only to this attempt's workspace, never extra host mounts.
    for path in workspace_aliases:result+=['--symlink',aliases[path],path]
    if writable_runtime_bin:
        runtime_bin=Path(project)/'runtime-bin'
        if runtime_bin.is_symlink() or not runtime_bin.is_dir():
            raise ValueError('Invalid runtime executable directory')
        result+=['--bind',str(runtime_bin),'/usr/local/bin']
    result+=['--bind',str(home),str(home)]
    if actor_release is not None:result+=['--bind',str(actor_events),str(actor_events)]
    else:result+=['--ro-bind' if readonly_logs else '--bind',str(logs),str(logs)]
    if actor_release is not None:
        # A read-only directory still exposes live Unix sockets. The actor must
        # never connect to the tmux server that owns its evaluation terminal.
        result+=['--unsetenv','TMUX','--unsetenv','TMUX_PANE','--dir',str(control)]
        if model_gateway:
            socket=str(Path(control)/'model.sock')
            result+=['--ro-bind',socket,socket]
    else:result+=['--ro-bind',str(control),str(control)]
    result+=['--chdir',workdir]
    if environment is not None:result+=['--bind',str(environment),'/opt/hicode-swe/env']
    if tests is not None:result+=['--bind' if writable_tests else '--ro-bind',str(tests),'/tests','--ro-bind' if readonly_logs else '--bind',str(Path(logs)/'verifier'),'/logs/verifier']
    if public_tests is not None:result+=['--ro-bind',str(public_tests),'/tests']
    return result+args
