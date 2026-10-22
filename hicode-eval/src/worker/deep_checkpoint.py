"""Explicit recovery from hashed, stopped DeepSWE Actor evidence, never verifier copies."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
from continuation import MAX_BYTES, MAX_FILES, model_bridge_port, validate_identity, validate_members
from protocol import Events

# Audited current-format runner before the large-session startup allowance.
# Its verifier used the same separate workspace/Home; this is not an old dataset reader.
AUDITED_RUNNER = 'e648b306e8b7273a0f8742c7c6dd753239fd48a32b36b465e14091e18b2e4154'


def read(path, limit):
    if path.parent.resolve() != path.parent: raise ValueError('Symlinked evidence parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit: raise ValueError('Invalid evidence file')
        data = stream.read(limit + 1)
    if len(data) > limit: raise ValueError('Evidence size exceeded')
    return data


def recover(run, output, module_hashes, unstarted_run=None):
    run, output = Path(run), Path(output)
    if run.resolve() != run or output.resolve() != output: raise ValueError('Noncanonical recovery path')
    state = json.loads(read(run/'state.json', 65536))
    if (state['id'] != run.name or state['dataset'] != 'deep-swe' or state['network'] != 'isolated'
            or state['state'] != 'error' or state['execution'] != 'timeout' or state['collection'] != 'complete'):
        raise ValueError('Recover only fully collected DeepSWE timeouts')
    # These reviewed modules keep the verifier in a separate workspace and Home.
    for name, expected in module_hashes.items():
        actual = hashlib.sha256(read(run/'worker'/name, 1024*1024)).hexdigest()
        if actual != expected and not (name == 'runner.py' and actual == AUDITED_RUNNER):
            raise ValueError('Frozen execution isolation differs from reviewed modules')
    receipt_data = read(run/'collection.json', 32*1024*1024)
    receipt = json.loads(receipt_data)
    if receipt.get('complete') is not True: raise ValueError('Incomplete Actor collection')
    evidence = run/'evidence'
    def checked(name, limit):
        record = receipt['files'][name]
        if 'symlink' in record: raise ValueError('Symlinked recovery metadata')
        data = read(evidence/name, limit)
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('Collected Actor evidence changed')
        return data
    shutdown = json.loads(checked('shutdown.json', 4096))
    if (shutdown.get('reason') != 'timeout' or not shutdown.get('cliExited') or not shutdown.get('turnSaved')
            or shutdown.get('pendingToolCallIds') != [] or not shutdown.get('eventStreamComplete') or shutdown.get('error')):
        raise ValueError('Actor shutdown was not sealed')
    disposed = json.loads(read(run/'container-disposed.json', 4096))
    if disposed.get('version') != 1 or disposed.get('runId') != run.name: raise ValueError('Container disposal unconfirmed')
    job = json.loads(read(run/'job.json', 65536))
    if job.get('dataset') != 'deep-swe' or job.get('network') != 'isolated' or job.get('service') is not None:
        raise ValueError('Unexpected DeepSWE execution contract')
    # A single root Session is selected from the runtime stream, not guessed from filenames.
    events = Events()
    stream = checked('actor-events/events.jsonl', 32*1024*1024)
    for offset in range(0, len(stream), 65536): events.accept(stream[offset:offset+65536])
    # SIGTERM cancels and persists the active turn. Its final UI busy flag is
    # not repainted before exit; require the shutdown seal, not normal completion.
    ending, settled = events.ending, events.settled
    if (events.partial or not events.ready or not events.started or events.pending_tools
            or not isinstance(ending, dict) or ending.get('session_id') != events.session_id
            or ending.get('status') != 'cancelled' or ending.get('reason') != 'shutdown'
            or ending.get('persistence_status') != 'saved' or not isinstance(settled, dict)
            or settled['sequence'] != events.sequence or settled.get('reason') != 'shutdown'
            or settled.get('status') != 'cancelled' or settled.get('persistenceStatus') != 'saved'
            or settled['runningAgents'] != 0
            or settled['pendingAgentMessages'] != 0):
        raise ValueError('Actor event stream does not confirm saved shutdown')
    session = events.session_id
    if not isinstance(session, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}', session):
        raise ValueError('Missing Actor Session identity')
    names = {}
    if '.hicode-evidence-paths.json' in receipt['files']:
        mapping = json.loads(checked('.hicode-evidence-paths.json', 16*1024*1024))
        if mapping.get('version') != 1: raise ValueError('Unknown evidence path map')
        for item in mapping['entries']:
            if item['stored'] in names: raise ValueError('Duplicate evidence path map')
            names[item['stored']] = item['original']
    selected = []
    total = 0
    for stored, record in receipt['files'].items():
        if (not isinstance(stored,str) or not isinstance(record,dict) or type(record.get('bytes')) is not int
                or not 0<=record['bytes']<=MAX_BYTES or not isinstance(record.get('sha256'),str)
                or not re.fullmatch('[a-f0-9]{64}',record['sha256'])): raise ValueError('Invalid collection record')
        original = names.get(stored, stored)
        for name in [stored, original]:
            parts = Path(name).parts
            if Path(name).is_absolute() or not parts or '..' in parts or len(name) > 4096: raise ValueError('Unsafe evidence path')
        if not original.startswith(('project/', 'home/')): continue
        if not stored.startswith(('project/', 'home/')): raise ValueError('Path map changes Actor boundary')
        total += record['bytes']
        selected.append((stored, original, record))
        if total > MAX_BYTES or len(selected) > MAX_FILES: raise ValueError('Actor snapshot exceeds budget')
    if not any(n.startswith('project/.git/') for _, n, _ in selected): raise ValueError('Missing Actor Git history')
    identities = [stored for stored, name, _ in selected if name.endswith('/identity.json') and '/sessions/' in name]
    matches = 0
    for name in identities:
        identity = json.loads(checked(name, 65536))
        if identity.get('sessionId') == session:
            matches += 1
            if identity.get('cwd') != '/app': raise ValueError('Actor Session workspace changed')
    if matches != 1: raise ValueError('Saved Actor Session identity is ambiguous')
    checked('home/.hicode/settings.json', 4*1024*1024)
    port = model_bridge_port(evidence/'home/.hicode/settings.json', job['model']['source'])
    target = output/'continuation.tar.gz'
    with tarfile.open(target, 'w:gz', compresslevel=1) as archive:
        directories = {'project', 'home'}
        for _, name, _ in selected:
            directories.update(str(p) for p in Path(name).parents if str(p) != '.')
        for name in sorted(directories, key=lambda s: (len(Path(s).parts), s)):
            member = tarfile.TarInfo(name);member.type = tarfile.DIRTYPE;member.mode = 0o700;archive.addfile(member)
        for stored, original, record in sorted(selected):
            path = evidence/stored
            if path.parent.resolve() != path.parent: raise ValueError('Actor file traverses a symlink')
            info = path.lstat()
            member = tarfile.TarInfo(original);member.mode = info.st_mode & 0o777;member.mtime = info.st_mtime
            if 'symlink' in record:
                link = os.readlink(path)
                if (not stat.S_ISLNK(info.st_mode) or link != record['symlink'] or len(link.encode()) != record['bytes']
                        or hashlib.sha256(link.encode()).hexdigest() != record['sha256']): raise ValueError('Actor symlink changed')
                member.type = tarfile.SYMTYPE;member.linkname = link;archive.addfile(member)
            else:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode) or before.st_size != record['bytes']: raise ValueError('Actor file size changed')
                    digest = hashlib.sha256()
                    class Reader:
                        def read(self, size):
                            data = stream.read(size);digest.update(data);return data
                    member.size = before.st_size;archive.addfile(member, Reader())
                    after = os.fstat(stream.fileno())
                    if (digest.hexdigest() != record['sha256'] or
                            (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns)):
                        raise ValueError('Actor file changed during recovery')
    with tarfile.open(target, 'r:gz') as archive: validate_members(archive, None)
    value = {'version': 1, 'runId': run.name, 'sessionId': session,
             'homePath': '/eval/runs/'+run.name+'/home', 'elapsedSeconds': state['budget']['agentSeconds'],
             'servicePaths': None, 'modelBridgePort': port, 'bytes': target.stat().st_size,
             'sha256': sha256_file(target)}
    validate_identity(value)
    if unstarted_run is not None:
        validate_unstarted(Path(unstarted_run), value)
    return value


def validate_unstarted(run, checkpoint):
    if run.resolve() != run: raise ValueError('Noncanonical rejected continuation')
    state = json.loads(read(run/'state.json', 65536))
    if (state.get('id') != run.name or state.get('dataset') != 'deep-swe' or state.get('network') != 'isolated'
            or state.get('state') not in {'error', 'cancelled'} or state.get('execution') not in {'failed', 'cancelled'}
            or state.get('grading') != 'unavailable' or state.get('collection') != 'complete'):
        raise ValueError('Only completely collected startup failures may reuse the input')
    disposed = json.loads(read(run/'container-disposed.json', 4096))
    if disposed.get('version') != 1 or disposed.get('runId') != run.name: raise ValueError('Rejected container not disposed')
    receipt = json.loads(read(run/'collection.json', 32*1024*1024))
    if receipt.get('complete') is not True: raise ValueError('Incomplete rejected continuation')
    data = read(run/'evidence/actor-events/events.jsonl', 32*1024*1024)
    record = receipt['files']['actor-events/events.jsonl']
    if record.get('symlink') or len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        raise ValueError('Rejected continuation events changed')
    events = Events()
    for offset in range(0, len(data), 65536): events.accept(data[offset:offset+65536])
    if events.partial or events.ready or events.started or events.last_type is not None or events.pending_tools:
        raise ValueError('Continuation already acknowledged input; do not discard its work')
    job = json.loads(read(run/'job.json', 65536))
    saved = job['continuation']['checkpoint']
    if any(saved[k] != checkpoint[k] for k in ['runId', 'sessionId', 'homePath', 'elapsedSeconds', 'modelBridgePort']):
        raise ValueError('Rejected continuation used a different saved input')


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(65536), b''): digest.update(data)
    return digest.hexdigest()


if __name__ == '__main__':
    print(json.dumps(recover(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4] if len(sys.argv)>4 else None)))
