"""Task UID teardown tolerates processes disappearing, but never hides access failures."""
import os
import signal
import select
import time
from pathlib import Path
from protocol import atomic_json


def process_start(pid):
    try:return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):return None


def open_task_cli(uid, script, event_log):
    """Pin the CLI process before submitting the task; never signal a reused PID."""
    if type(uid) is not int or uid < 20000:
        raise ValueError('Expected an evaluation task UID')
    matches = []
    try:
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            fd = None
            try:
                if path.stat().st_uid != uid:
                    continue
                fd = os.pidfd_open(int(path.name))
                args = path.joinpath('cmdline').read_bytes().split(b'\0')
                marker = b'--event-log'
                if (path.stat().st_uid == uid and len(args) > 2 and Path(os.fsdecode(args[0])).name == 'bun' and args[1] == os.fsencode(script)
                        and marker in args and args[args.index(marker) + 1] == os.fsencode(event_log)):
                    matches.append(fd)
                    fd = None
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        if len(matches) != 1:
            raise RuntimeError('Cannot uniquely identify the task CLI for graceful shutdown')
        return matches.pop()
    finally:
        for fd in matches:
            os.close(fd)


def terminate_task_cli(fd, drain_events, grace_seconds=10):
    """Only request shutdown here. The owner force-cleans all task processes afterwards."""
    started = time.monotonic()
    try:
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    except ProcessLookupError:
        pass
    while True:
        drain_events()
        remaining = max(0, grace_seconds - (time.monotonic() - started))
        if select.select([fd], [], [], min(.1, remaining))[0]:
            while drain_events() and time.monotonic() - started < grace_seconds:
                pass
            return True
        if remaining == 0:
            return False


def stop_task_processes(uid):
    if type(uid) is not int or uid < 20000:
        raise ValueError('Expected an evaluation task UID')
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid == uid:
                os.kill(int(path.name), signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
    for _ in range(50):
        alive = False
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                if path.stat().st_uid == uid:
                    state = path.joinpath('stat').read_text().rsplit(')', 1)[1].split()[0]
                    if state != 'Z':
                        alive = True
            except (FileNotFoundError, ProcessLookupError):
                # A process may vanish between directory enumeration, stat and read.
                pass
        if not alive:
            return
        time.sleep(.1)
    raise RuntimeError('Task processes could not be stopped')


def finalize_task(root, result):
    # An outcome is evidence, not proof that cleanup has completed.
    atomic_json(root / 'outcome.json', result)
    stop_task_processes(result['uid'])
    atomic_json(root / 'result.json', result)
