"""Run-owned service namespace; the Agent and private verifier have separate lifetimes."""
import ctypes
import json
import os
from pathlib import Path
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

SYSTEM_PATHS = {'/etc', '/var', '/run', '/home', '/git', '/srv'}
ACCOUNT_COUNT = 65536
READY_FILE = '/tmp/.hicode-service-ready'


def service_paths(config):
    value = config.get('service')
    if value is None:return None
    if (config.get('dataset') not in {'terminal-bench-2.1'}
            or config.get('network') != 'isolated' or not isinstance(value, dict)
            or set(value) != {'writablePaths'} or not isinstance(value['writablePaths'], list)
            or len(value['writablePaths']) > len(SYSTEM_PATHS)
            or any(not isinstance(p, str) or p not in SYSTEM_PATHS for p in value['writablePaths'])
            or len(set(value['writablePaths'])) != len(value['writablePaths'])):
        raise ValueError('Invalid reviewed service execution declaration')
    return value['writablePaths']


def _user_namespace_exec(args):
    if os.getuid()!=0:raise ValueError('Expected mapped root in the owned service namespace')
    if not args or args[0] != 'bwrap' or args.count('--unshare-user') != 1:
        raise ValueError('Expected the scoped Bubblewrap command')
    os.execvp('bwrap', ['bwrap', '--cap-add', 'ALL',
                        *(arg for arg in args[1:] if arg != '--unshare-user')])


def _verifier_exec(pid,args):
    # Join only the service network. Bubblewrap must still be able to bind
    # private verifier inputs from the caller's mount namespace; entering the
    # service mount namespace would make those inputs unreachable.
    user=os.open(f'/proc/{pid}/ns/user',os.O_RDONLY)
    network=os.open(f'/proc/{pid}/ns/net',os.O_RDONLY)
    libc=ctypes.CDLL(None,use_errno=True)
    try:
        if libc.setns(user,0):raise OSError(ctypes.get_errno(),'Cannot enter service user namespace')
        os.setgroups([]);os.setgid(0);os.setuid(0)
        if libc.setns(network,0):raise OSError(ctypes.get_errno(),'Cannot enter service network namespace')
    finally:os.close(user);os.close(network)
    _user_namespace_exec(args)


class ServiceNamespace:
    def __init__(self, root, uid, paths):
        if type(uid) is not int or uid < 20000 or uid + ACCOUNT_COUNT >= 2**32:
            raise ValueError('Invalid service account mapping')
        self.root, self.uid = Path(root), uid
        self.sandbox_runtime = self.root / 'service-sandbox'
        self.paths = paths
        self.mounts = []
        self.process = None
        self.pid = None
        self.start_identity = None
        self.pidfd = None
        self.output = None

    def prepare(self):
        from protocol import atomic_json
        runtime=self.sandbox_runtime/'bin'
        runtime.mkdir(parents=True,mode=0o755)
        self.sandbox_runtime.chmod(0o755);runtime.chmod(0o755)
        helper=Path('/opt/hicode-eval/service_bwrap.py')
        if helper.is_symlink() or not helper.is_file() or not Path('/usr/bin/socat').is_file():
            raise RuntimeError('Service sandbox helpers are missing')
        shutil.copyfile(helper,runtime/'bwrap')
        (runtime/'bwrap').chmod(0o755)
        (runtime/'socat').symlink_to('/usr/bin/socat')
        directory = self.root / 'service-system'
        directory.mkdir(mode=0o700)
        os.chown(directory,self.uid,self.uid)
        ownership={}
        for name in self.paths:
            if name not in SYSTEM_PATHS:raise ValueError('Unreviewed system path')
            source, destination = Path(name), directory / name[1:]
            if source.is_symlink():raise ValueError('System path cannot be a symlink')
            if source.exists() and name!='/run':shutil.copytree(source, destination, symlinks=True)
            else:destination.mkdir()
            for path in [destination, *destination.rglob('*')]:
                original = (source/path.relative_to(destination)).lstat() if source.exists() and name!='/run' else path.lstat()
                if original.st_uid >= ACCOUNT_COUNT or original.st_gid >= ACCOUNT_COUNT:
                    raise ValueError('Prepared system account exceeds mapping')
                ownership[str(path.relative_to(directory))]=[original.st_uid,original.st_gid]
                os.lchown(path,self.uid,self.uid)
            self.mounts += ['--bind',str(destination),name]
        atomic_json(directory/'ownership.json',ownership)
        os.chown(directory/'ownership.json',self.uid,self.uid)
        self.mounts += ['--ro-bind',str(directory/'ownership.json'),'/.hicode-service-ownership']
        self.mounts += ['--ro-bind',str(self.sandbox_runtime),str(self.sandbox_runtime)]
        # /root is the same private Home, never the preparation machine's Home.
        self.mounts += ['--bind', str(self.root / 'home'), '/root']

    def start(self, namespace, environment, model_socket=None):
        from protocol import atomic_json
        from cleanup import process_start
        if self.process is not None:raise ValueError('Service namespace already started')
        args = ['python3', '/opt/hicode-eval/service_namespace.py', '--keep', *self.paths]
        argv = namespace(args)
        mounts=list(self.mounts)
        if model_socket is not None:
            socket_path=Path(model_socket)
            expected=Path('/run/hicode-eval')/self.root.name/'model.sock'
            if socket_path!=expected or socket_path.resolve()!=expected or socket_path.is_symlink():raise ValueError('Model socket must belong to this service run')
            info=socket_path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=self.uid:raise ValueError('Invalid owned model socket')
            # The private /run overlay hides earlier mounts. Re-expose only
            # the owned model socket after all service system directories.
            mounts+=['--dir',str(socket_path.parent),'--ro-bind',str(socket_path),str(socket_path)]
        argv = argv[:-len(args)] + mounts + ['--as-pid-1'] + args
        ready_read, ready_write = os.pipe()
        go_read, go_write = os.pipe()
        info_read, info_write = os.pipe()
        self.output = (self.root / 'service-namespace.log').open('w')
        try:
            self.process = subprocess.Popen(
                ['python3', '/opt/hicode-eval/service_namespace.py', '--map', str(ready_write), str(go_read),
                 *argv[:1], '--info-fd', str(info_write), *argv[1:]],
                env=environment, pass_fds=(ready_write, go_read, info_write),
                stdin=subprocess.DEVNULL, stdout=self.output, stderr=self.output)
            os.close(ready_write);ready_write = None
            os.close(go_read);go_read = None
            os.close(info_write);info_write = None
            if not select.select([ready_read], [], [], 5)[0] or os.read(ready_read, 1) != b'1':
                raise RuntimeError('Service user namespace did not initialize; see service-namespace.log')
            for kind in ['uid_map', 'gid_map']:
                Path(f'/proc/{self.process.pid}/{kind}').write_text(f'0 {self.uid} {ACCOUNT_COUNT}\n')
            os.write(go_write, b'1');os.close(go_write);go_write = None
            if not select.select([info_read], [], [], 5)[0]:raise RuntimeError('Service namespace startup timed out')
            raw=os.read(info_read,4096)
            if not raw:
                raise RuntimeError('Service namespace exited: '+(self.root/'service-namespace.log').read_text()[-2000:])
            info = json.loads(raw)
            self.pid = info['child-pid']
            if type(self.pid) is not int or self.pid <= 0:raise ValueError('Invalid service namespace PID')
            self.start_identity = process_start(self.pid)
            if self.start_identity is None:raise RuntimeError('Service namespace exited during startup')
            self.pidfd = os.pidfd_open(self.pid)
            deadline = time.monotonic() + 5
            while True:
                if self._ready():
                    result = subprocess.run(self.actor_argv(['true']), capture_output=True, timeout=2)
                    if result.returncode == 0:break
                if time.monotonic() >= deadline:raise RuntimeError('Cannot enter the persistent service namespace')
                time.sleep(.05)
            atomic_json(self.root / 'service.json', {'version': 1, 'pid': self.pid, 'start': self.start_identity,
                                                    'uid': self.uid, 'accountCount': ACCOUNT_COUNT})
        except BaseException:
            self.close()
            raise
        finally:
            for fd in [ready_read, ready_write, go_read, go_write, info_read, info_write]:
                if fd is not None:os.close(fd)

    def _ready(self):
        self._check()
        path=Path(f'/proc/{self.pid}/root'+READY_FILE)
        try:info=path.lstat()
        except FileNotFoundError:return False
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=self.uid:
            raise RuntimeError('Invalid service readiness marker')
        return info.st_size==6 and path.read_bytes()==b'ready\n'

    def _check(self):
        from cleanup import process_start
        if (self.pid is None or self.process is None or self.process.poll() is not None
                or process_start(self.pid) != self.start_identity
                or Path(f'/proc/{self.pid}').stat().st_uid != self.uid):
            raise RuntimeError('Service namespace identity changed or exited')

    def actor_argv(self, args):
        self._check()
        return ['nsenter', '--target', str(self.pid), '--user', '--mount', '--net', '--pid',
                '--root', '--setuid', '0', '--setgid', '0', 'env', '-C', '/app', '-u', 'TMUX', '-u', 'TMUX_PANE', *args]

    def verifier_argv(self, args, namespace):
        self._check()
        argv = namespace(args)
        mounts=[]
        for path in self.paths:mounts+=['--bind',str(self.root/'service-system'/path[1:]),path]
        mounts+=['--bind',str(self.root/'home'),'/root']
        argv = argv[:-len(args)] + mounts + args
        # Enter only user/network; the verifier gets a sibling PID namespace and
        # its own minimal filesystem. Service processes cannot see hidden tests.
        return ['python3','/opt/hicode-eval/service_namespace.py','--verifier',str(self.pid),*argv]

    def snapshot(self):
        if not self.paths:return
        with (self.root/'service-system.tar').open('wb') as output:
            subprocess.run(self.actor_argv(['tar','--numeric-owner','-cf','-','-C','/',*[p[1:] for p in self.paths]]),
                           stdout=output,stderr=subprocess.PIPE,check=True,timeout=60)

    def close(self):
        if self.pidfd is not None:
            try:signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
            except ProcessLookupError:pass
            finally:os.close(self.pidfd);self.pidfd = None
        if self.process is not None:
            if self.process.poll() is None:self.process.kill()
            self.process.wait(timeout=5);self.process = None
        if self.output is not None:self.output.close();self.output = None


def main():
    mode, *args = sys.argv[1:]
    if mode == '--map':
        ready, go = map(int, args[:2])
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.unshare(0x10000000):raise OSError(ctypes.get_errno(), 'Cannot create service user namespace')
        os.write(ready, b'1');os.close(ready)
        if os.read(go, 1) != b'1':raise RuntimeError('Service namespace owner disappeared')
        os.close(go);os.setgroups([]);os.setgid(0);os.setuid(0)
        _user_namespace_exec(args[2:])
    elif mode == '--exec':_user_namespace_exec(args)
    elif mode == '--verifier':_verifier_exec(int(args[0]),args[1:])
    elif mode == '--keep':
        ownership=json.loads(Path('/.hicode-service-ownership').read_text())
        for path in args:
            if path not in SYSTEM_PATHS:raise ValueError('Unreviewed service path')
        for name,owner in ownership.items():
            path=Path(name)
            if path.is_absolute() or '..' in path.parts or '/'+path.parts[0] not in args:
                raise ValueError('Invalid service seed ownership path')
            os.lchown('/'+name,*owner)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 1, 0, 0, 0):raise OSError(ctypes.get_errno(), 'Cannot expose owned namespace handles')
        # Bubblewrap reports the PID before the final root and ownership are
        # ready. A successful command in its earlier root is not readiness.
        fd=os.open(READY_FILE,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try:os.write(fd,b'ready\n')
        finally:os.close(fd)
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:pass
            except ChildProcessError:pass
            time.sleep(.1)
    else:raise ValueError('Unknown service namespace entry')


if __name__ == '__main__':main()
