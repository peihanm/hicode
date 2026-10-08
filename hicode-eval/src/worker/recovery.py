"""Reconcile one completed attempt from durable evidence; never start an Agent."""
import fcntl
import hashlib
import json
import os
import pwd
import re
import stat
import sys
import time
from pathlib import Path
import cleanup
from protocol import Events, atomic_json
from dataset_runtime import dataset_runtime


def read_bytes(path, limit):
    if path.resolve() != path.absolute():
        raise ValueError('Symlinked recovery evidence')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Recovery requires regular files')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Recovery evidence exceeds limit')
        return data


def record(path):
    return json.loads(read_bytes(path, 65536))


def process_start(pid):
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def recover(root):
    if not re.fullmatch('[a-f0-9]{16}', root.name) or root.resolve() != root.absolute():
        raise ValueError('Invalid recovery directory')
    fd = os.open(root / '.recovery.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError('Invalid recovery lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identity = record(root / 'identity.json')
        if (identity.get('version') != 2 or identity.get('run') != root.name
                or identity.get('user') != 'eval-' + root.name
                or type(identity.get('uid')) is not int or identity['uid'] < 20000
                or type(identity.get('pid')) is not int or identity['pid'] <= 0
                or not isinstance(identity.get('runnerStart'), str) or not identity['runnerStart'].isdigit()):
            raise ValueError('Invalid or unsupported task identity; inspect manually')
        if pwd.getpwnam(identity['user']).pw_uid != identity['uid']:
            raise ValueError('Task account identity changed')
        if process_start(identity['pid']) == identity['runnerStart']:
            raise RuntimeError('Original task runner is still alive')
        outcome = record(root / 'outcome.json')
        if (set(outcome) != {'execution', 'grading', 'uid'} or type(outcome['uid']) is not int
                or outcome['uid'] != identity['uid']
                or outcome['execution'] not in {'completed', 'failed', 'timeout', 'cancelled'}
                or outcome['grading'] not in {'passed', 'failed', 'unavailable'}):
            raise ValueError('Invalid outcome checkpoint')
        if (root / 'result.json').exists() and record(root / 'result.json') != outcome:
            raise ValueError('Outcome and completion receipt disagree')
        proof = {'identity.json': hashlib.sha256(read_bytes(root / 'identity.json', 65536)).hexdigest(),
                 'outcome.json': hashlib.sha256(read_bytes(root / 'outcome.json', 65536)).hexdigest()}
        if outcome['execution'] == 'completed' or (outcome['execution'] == 'failed' and outcome['grading'] != 'unavailable'):
            data = read_bytes(root / 'actor-events/events.jsonl', 256 * 1024 * 1024)
            events = Events()
            for offset in range(0, len(data), 65536):
                events.accept(data[offset:offset + 65536])
            if outcome['execution'] == 'completed':
                if events.partial.strip() or not events.ready or not events.complete() or events.settled['reason'] != 'completed':
                    raise ValueError('No sealed, persisted completion event')
            else:
                shutdown = record(root/'shutdown.json')
                if (not events.ready or not events.failed_turn() or events.pending_tools
                        or events.ending.get('persistence_status') != 'saved'
                        or type(shutdown.get('version')) is not int or shutdown['version'] != 1
                        or shutdown.get('reason') != 'failed' or shutdown.get('cliExited') is not True
                        or shutdown.get('turnSaved') is not True or shutdown.get('pendingToolCallIds') != []
                        or shutdown.get('eventStreamComplete') is not True or shutdown.get('error') is not None):
                    raise ValueError('No confirmed shutdown for failed execution')
                proof['shutdown.json'] = hashlib.sha256(read_bytes(root/'shutdown.json',65536)).hexdigest()
            proof['actor-events/events.jsonl'] = hashlib.sha256(data).hexdigest()
        if outcome['grading'] != 'unavailable':
            if outcome['execution'] not in {'completed', 'timeout', 'failed'}:
                raise ValueError('Cancelled execution cannot claim a grade')
            job=record(root/'job.json')
            proof.update(dataset_runtime(job).recovery_evidence(root,job,outcome['grading'],read_bytes))
            reward = read_bytes(root / 'logs/verifier/reward.txt', 32).strip()
            if reward != (b'1' if outcome['grading'] == 'passed' else b'0'):
                raise ValueError('Reward and outcome disagree')
            proof['logs/verifier/reward.txt'] = hashlib.sha256(reward).hexdigest()
        receipt = root / 'recovery.json'
        if receipt.exists():
            previous = record(receipt)
            if previous.get('version') != 1 or previous.get('run') != root.name or previous.get('result') != outcome or previous.get('evidence') != proof:
                raise ValueError('Recovery evidence changed since prior reconciliation')
        cleanup.stop_task_processes(outcome['uid'])
        if not (root / 'result.json').exists():
            atomic_json(root / 'result.json', outcome)
        if not receipt.exists():
            atomic_json(receipt, {'version': 1, 'run': root.name, 'at': time.time(), 'result': outcome, 'evidence': proof})
        return outcome


if __name__ == '__main__':
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{16}', sys.argv[1]):
        raise SystemExit('Expected one task ID')
    print(json.dumps(recover(Path('/eval/runs') / sys.argv[1])))
