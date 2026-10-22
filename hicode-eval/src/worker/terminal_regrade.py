"""Recheck a sealed Terminal answer, optionally restoring its service, without a model."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import tarfile
import time

from protocol import atomic_json, namespace_argv, Events
from service_namespace import ServiceNamespace, service_paths, verifier_options, ACCOUNT_COUNT
from dataset_runtime import dataset_runtime
from evidence_export import read_map, restore


def validate_snapshot(path, paths):
    with tarfile.open(path) as archive:
        names, links, total = set(), set(), 0
        for entry in archive:
            name = Path(entry.name)
            if (name.is_absolute() or '..' in name.parts or not name.parts
                    or '/' + name.parts[0] not in paths
                    or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk())
                    or not 0 <= entry.uid < ACCOUNT_COUNT or not 0 <= entry.gid < ACCOUNT_COUNT):
                raise ValueError('Unsafe service snapshot member')
            if str(name) in names or len(names) >= 100000:
                raise ValueError('Duplicate or excessive service snapshot members')
            names.add(str(name)); total += entry.size
            if total > 8 * 1024 ** 3: raise ValueError('Service snapshot exceeds evidence budget')
            if entry.issym() or entry.islnk(): links.add(str(name))
            if entry.islnk():
                link = Path(entry.linkname)
                if link.is_absolute() or '..' in link.parts or not link.parts or '/' + link.parts[0] not in paths:
                    raise ValueError('Unsafe service snapshot hardlink')
        for name in names:
            if any(str(parent) in links for parent in Path(name).parents):
                raise ValueError('Service snapshot member traverses a link')


def validate_completion(data, *, execution='completed', shutdown=None):
    events = Events()
    for offset in range(0, len(data), 65536):events.accept(data[offset:offset + 65536])
    if execution == 'failed':
        if (events.partial.strip() or not events.ready or not events.failed_turn() or events.pending_tools
                or events.ending.get('persistence_status') != 'saved' or not isinstance(shutdown, dict)
                or type(shutdown.get('version')) is not int or shutdown['version'] != 1
                or shutdown.get('reason') != 'failed' or shutdown.get('cliExited') is not True
                or shutdown.get('turnSaved') is not True or shutdown.get('pendingToolCallIds') != []
                or shutdown.get('eventStreamComplete') is not True or shutdown.get('error') is not None):
            raise ValueError('Failed recheck requires saved events and confirmed shutdown')
    elif execution not in {'completed', 'cancelled'} or not events.ready or not events.complete() or events.settled['reason'] != 'completed':
        raise ValueError('Ordinary recheck requires settled, saved completion events')


def main():
    root = Path(sys.argv[1])
    import re
    if root.resolve()!=root or not re.fullmatch(r'/eval/rechecks/[a-f0-9]{16}/[a-f0-9]{16}',str(root)):
        raise ValueError('Invalid recheck directory')
    config = json.loads((root / 'job.json').read_text())
    identity = json.loads((root / 'input.json').read_text())
    if identity.get('version')!=1 or identity.get('runId')!=root.parent.name or identity.get('reviewId')!=root.name:
        raise ValueError('Invalid recheck identity')
    if 'pathMapSha256' in identity:
        data=read_map(root / 'evidence-paths.json')
        if hashlib.sha256(data).hexdigest()!=identity['pathMapSha256']:
            raise ValueError('Evidence path map hash mismatch')
        restore(root / 'project', json.loads(data), 'project')
    uid = 20000
    paths = service_paths(config) if config.get('service') is not None else None
    if config['dataset'] not in {'terminal-bench-2.1', 'deep-swe'}:
        raise ValueError('Unsupported sealed-answer recheck')
    if config['dataset'] == 'deep-swe' and (paths is not None or config['network'] != 'isolated'):
        raise ValueError('DeepSWE recheck must remain isolated')
    if paths is None and identity.get('kind') != 'ordinary':
        raise ValueError('Ordinary recheck identity missing')
    snapshot = root / 'service-system.tar'
    restart = root / 'service-restart.sh'
    if paths is not None:
        for path, key in [(snapshot, 'snapshotSha256'), (restart, 'restartSha256')]:
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != identity[key]:
                raise ValueError('Recheck input hash mismatch')
        validate_snapshot(snapshot, paths)
    else:
        completion = root / 'completion-events.jsonl'
        if completion.is_symlink() or not completion.is_file() or completion.stat().st_size > 256*1024*1024:
            raise ValueError('Invalid completion event evidence')
        data=completion.read_bytes()
        if hashlib.sha256(data).hexdigest()!=identity.get('eventsSha256'):
            raise ValueError('Completion event hash mismatch')
        execution = identity.get('originalExecution')
        shutdown = None
        if execution == 'failed':
            if config['dataset'] != 'deep-swe':raise ValueError('Failed recheck is DeepSWE-only')
            path = root / 'shutdown.json'
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                raise ValueError('Invalid failed shutdown evidence')
            proof = path.read_bytes()
            if hashlib.sha256(proof).hexdigest() != identity.get('shutdownSha256'):
                raise ValueError('Shutdown evidence hash mismatch')
            shutdown = json.loads(proof)
        validate_completion(data, execution=execution, shutdown=shutdown)
    subprocess.run(['useradd', '--uid', str(uid), '--user-group', '--no-create-home', 'eval-recheck'], check=True)
    account = pwd.getpwuid(uid)
    project, home, logs = root / 'project', root / 'home', root / 'logs'
    control = Path('/run/hicode-eval') / root.name
    for path in [project, home, logs, logs / 'verifier', root / 'actor-events', control]:
        path.mkdir(parents=True, exist_ok=True)
    subprocess.run(['chown', '-hR', f'{uid}:{account.pw_gid}', str(project), str(home), str(logs), str(root / 'actor-events'), str(control)], check=True)
    os.chmod(root, 0o755)
    owner = ServiceNamespace(root, uid, paths, network=config['network'],**verifier_options(config['service'])) if paths is not None else None
    dataset = dataset_runtime(config)
    cancelled = [False]
    signal.signal(signal.SIGTERM, lambda *_: cancelled.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: cancelled.__setitem__(0, True))
    started = time.monotonic()

    def base(args, *, actor=False, verifier=False):
        return namespace_argv(args, project, home, logs, control,
                              root / 'tests' if verifier else None,
                              writable_tests=dataset.writable_tests(config) if verifier else False,
                              workspace_aliases=dataset.workspace_aliases(config),
                              writable_runtime_bin=dataset.writable_runtime_bin(config),
                              actor_release=config['release'] if actor else None,
                              actor_events=root / 'actor-events' if actor else None,
                              verifier_release=config['release'] if verifier else None,
                              isolated_network=actor and config['network'] == 'isolated')

    def namespace(args, *, verifier=False, setup=False):
        if owner is None:
            if config.get('verifierRootOverlay') or config.get('verifierChroot'):
                raise ValueError('Ordinary recheck does not support alternate verifier roots')
            result=base(args,verifier=verifier)
            packages=[]
            if verifier:
                for path in ['/opt/hicode-verifier','/opt/hicode-terminal/verifier']:
                    if Path(path).exists():packages+=['--ro-bind',path,path]
            return result[:-len(args)]+packages+args
        if verifier:
            def view(argv):
                result = base(argv, verifier=True)
                packages = []
                for path in ['/opt/hicode-verifier', '/opt/hicode-terminal/verifier']:
                    if Path(path).exists(): packages += ['--ro-bind', path, path]
                return result[:-len(argv)] + packages + argv
            return owner.verifier_argv(args, view)
        return owner.actor_argv(args)

    def demote():
        os.setgid(account.pw_gid);os.setuid(uid)

    def command(args, *, timeout=30, extra=None, output_path=None):
        if cancelled[0]: raise RuntimeError('Recheck cancelled')
        with (output_path or logs / 'commands.txt').open('a') as output:
            return subprocess.run(args, env={**os.environ, **(extra or {})}, stdout=output,
                                  stderr=subprocess.STDOUT, timeout=timeout, check=True,preexec_fn=demote if owner is None else None)

    grade, reason = 'unavailable', None
    try:
        if owner is not None:
            owner.prepare()
            owner.start(lambda args: base(args, actor=True), {'PATH':os.environ['PATH'], 'HOME':str(home), 'LANG':'C.UTF-8'})
            # Restore only inside the mapped, disposable service filesystem. Hidden tests
            # are absent from its minimal mount view and no gateway or credentials exist.
            destination = project / '.service-snapshot.tar'
            destination.write_bytes(snapshot.read_bytes())
            os.chown(destination, uid, account.pw_gid)
            try: command(owner.actor_argv(['tar', '--numeric-owner', '-xf', '/app/.service-snapshot.tar', '-C', '/']), timeout=60)
            finally: destination.unlink(missing_ok=True)
            script = project / '.service-restart.sh'
            script.write_bytes(restart.read_bytes()); os.chown(script, uid, account.pw_gid)
            try: command(owner.actor_argv(['bash', '/app/.service-restart.sh']), timeout=90)
            finally: script.unlink(missing_ok=True)
        grade, output = dataset.grade(root=root, config=config, uid=uid, gid=account.pw_gid,
                                      project=project, home=home, logs=logs, command=command,
                                      namespace=namespace, demote=demote if owner is None else None, cancelled=lambda:cancelled[0])
        if grade == 'unavailable': reason = output[-2000:]
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        reason = str(error)[-2000:]
    finally:
        if owner is not None:owner.close()
    atomic_json(root / 'result.json', {'version':1, 'runId':identity['runId'], 'reviewId':identity['reviewId'],
                'grading':grade, 'reason':reason, 'modelCalls':0,
                'projectSha256':identity['projectSha256'],
                **({'snapshotSha256':identity['snapshotSha256']} if owner is not None else {'kind':'ordinary'}),
                'elapsedSeconds':round(time.monotonic()-started, 3)})


if __name__ == '__main__': main()
