"""DeepSWE's committed-patch collection and original pristine verifier."""
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import time
from pathlib import Path
from protocol import atomic_json, namespace_argv
from verifier import display_output


def checked_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ValueError('Invalid DeepSWE evidence file')
        data = stream.read(limit + 1)
    if len(data) > limit:raise ValueError('DeepSWE evidence exceeds budget')
    return data


def expected_ids(config):
    result = {}
    for bucket in ['p2p', 'f2p']:
        ids = config[bucket + '_node_ids']
        if not isinstance(ids, list) or any(not isinstance(x, str) or not x.strip() for x in ids):
            raise ValueError('Invalid DeepSWE test whitelist')
        result[bucket] = list(dict.fromkeys(x.strip() for x in ids))
    if not result['f2p']:raise ValueError('DeepSWE requires fail-to-pass tests')
    return result


def validate_result(reward, ctrf, original, grading):
    ids = expected_ids(original)
    for bucket, names in ids.items():
        total, passed = reward[bucket + '_total'], reward[bucket + '_passed']
        if type(total) is not int or total != len(names) or type(passed) is not int or not 0 <= passed <= total:
            raise ValueError('DeepSWE whitelist and reward disagree')
    success = all(reward[b + '_passed'] == len(names) for b, names in ids.items())
    if type(reward['reward']) is not int or reward['reward'] != int(success) or grading != ('passed' if success else 'failed'):
        raise ValueError('DeepSWE score disagrees with test counts')
    if reward.get('apply_failed') == 1:
        if success or any(reward[b + '_passed'] for b in ids) or ctrf is not None:
            raise ValueError('Invalid patch-application failure')
        return
    report=ctrf['results'];summary=report['summary']
    total=sum(len(names) for names in ids.values());passed=sum(reward[b+'_passed'] for b in ids)
    expected_summary={'tests':total,'passed':passed,'failed':total-passed,'skipped':0,'pending':0,'other':0}
    if any(type(summary.get(k)) is not int or summary[k]!=v for k,v in expected_summary.items()):
        raise ValueError('DeepSWE report summary disagrees with whitelist')
    tests = report['tests']
    expected = {f'[{b}] {name}' for b, names in ids.items() for name in names}
    if len(tests) != len(expected) or {t['name'] for t in tests} != expected:
        raise ValueError('DeepSWE report does not cover the original whitelist')
    if any(t['status'] not in {'passed', 'failed', 'skipped', 'pending', 'other'} for t in tests):
        raise ValueError('Unknown DeepSWE test status')
    for bucket in ids:
        if sum(t['status'] == 'passed' and t['name'].startswith(f'[{bucket}] ') for t in tests) != reward[bucket + '_passed']:
            raise ValueError('DeepSWE report and reward disagree')


def supervise(args, *, timeout, output, env, demote, cancelled):
    if cancelled():raise RuntimeError('DeepSWE verification cancelled')
    if timeout <= 0:raise TimeoutError('DeepSWE verifier budget exhausted')
    with output.open('wb') as log:
        process = subprocess.Popen(args, env=env, preexec_fn=demote, start_new_session=True,
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            end = time.monotonic() + timeout
            while process.poll() is None:
                if cancelled():raise RuntimeError('DeepSWE verification cancelled')
                if time.monotonic() >= end:raise TimeoutError('DeepSWE verification timed out')
                time.sleep(.1)
            return process.returncode
        finally:
            try:os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:pass
            process.wait()


class DeepSweRuntime:
    workdir = '/app'
    actor_environment = None
    verifier_root = None

    def public_test_entries(self, config):return ['/app/（原仓库公开测试）']
    def writable_tests(self, config):return False
    def workspace_aliases(self, config):return []
    def writable_runtime_bin(self, config):return False
    def command_environment(self, config, home, root):
        runtime = config['deep']['runtimeEnvironment']
        if (not isinstance(runtime, dict) or set(runtime) - {'PYTHONPATH', 'VIRTUAL_ENV'}
                or any(not isinstance(value, str) for value in runtime.values())):
            raise ValueError('Invalid reviewed DeepSWE runtime environment')
        if ('PYTHONPATH' in runtime and runtime['PYTHONPATH'] not in {'/app', '/app/src'}
                or 'VIRTUAL_ENV' in runtime and runtime['VIRTUAL_ENV'] != '/opt/venv'):
            raise ValueError('DeepSWE runtime environment escapes prepared dependencies')
        result = {'PYTHONDONTWRITEBYTECODE': '1', **runtime}
        if 'VIRTUAL_ENV' in runtime:result['PATH'] = runtime['VIRTUAL_ENV'] + '/bin:' + os.environ['PATH']
        return result

    def prepare_actor(self, config, project, logs, command, namespace):
        if config['network'] != 'isolated':raise ValueError('DeepSWE requires no-network execution')
        runtime = self.command_environment(config, None, None)
        if 'VIRTUAL_ENV' in runtime:
            command(namespace(['python3','-c','import sys; assert sys.prefix == "/opt/venv", "Prepared virtual environment is unavailable"']))
        commit = config['deep']['baseCommit']
        if not isinstance(commit, str) or not re.fullmatch('[a-f0-9]{40}', commit):raise ValueError('Invalid DeepSWE baseline')
        if command(namespace(['git', '-C', '/app', 'rev-parse', 'HEAD'])).strip() != commit:
            raise ValueError('DeepSWE actor baseline changed')
        command(namespace(['git', '-C', '/app', 'config', 'user.name', 'HiCode']))
        command(namespace(['git', '-C', '/app', 'config', 'user.email', 'hicode@localhost']))

    def grade(self, *, root, config, uid, gid, project, home, logs, command, namespace, demote, cancelled):
        verifier = logs / 'verifier'
        original = json.loads(checked_bytes(root / 'tests/config.json', 16 * 1024 * 1024))
        artifacts = root / 'artifacts';artifacts.mkdir(mode=0o755)
        patch = artifacts / 'model.patch'
        env = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'HOME': str(home),
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
        env.update(self.command_environment(config, home, root))
        collect = namespace_argv(['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                                 '-C', '/app', 'diff', '--no-ext-diff', '--no-textconv', '--binary', config['deep']['baseCommit'], 'HEAD'],
                                project, home, logs, Path('/run/hicode-eval') / root.name,
                                isolated_network=True, actor_release=config['release'], actor_events=root / 'actor-events')
        # stderr is separate: only the original committed diff may enter model.patch.
        with patch.open('wb') as output, (verifier / 'collect.txt').open('wb') as errors:
            process = subprocess.Popen(collect, env=env, preexec_fn=demote, start_new_session=True, stdout=output, stderr=errors)
            try:
                deadline = time.monotonic() + 300
                while process.poll() is None:
                    if cancelled():raise RuntimeError('DeepSWE collection cancelled')
                    if time.monotonic() >= deadline:raise TimeoutError('DeepSWE collection timed out')
                    if patch.stat().st_size > 16 * 1024 * 1024:raise ValueError('DeepSWE patch exceeds budget')
                    time.sleep(.1)
                if process.returncode:raise RuntimeError('DeepSWE committed-patch collection failed')
            finally:
                try:os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait()
        patch_data = checked_bytes(patch, 16 * 1024 * 1024)
        atomic_json(root / 'patch-manifest.json', {'baseCommit': config['deep']['baseCommit'],
                                                'sha256': hashlib.sha256(patch_data).hexdigest(), 'bytes': len(patch_data)})
        patch.chmod(0o444)
        fresh = root / 'verifier-project';fresh_home = root / 'verifier-home'
        baseline = root / 'baseline'
        if baseline.is_symlink() or not baseline.is_dir():raise ValueError('Missing protected DeepSWE baseline')
        shutil.copytree(baseline, fresh, symlinks=True);fresh_home.mkdir()
        subprocess.run(['chown', '-hR', f'{uid}:{gid}', str(fresh), str(fresh_home)], check=True)
        args = namespace_argv(['--ro-bind', str(artifacts), '/logs/artifacts', 'bash', '/tests/test.sh'],
                              fresh, fresh_home, logs, Path('/run/hicode-eval') / root.name,
                              tests=root / 'tests', isolated_network=True, verifier_release=config['release'])
        env.update(HOME=str(fresh_home))
        code = supervise(args, timeout=config['verifierSeconds'],
                         output=verifier / 'test-stdout.txt', env=env, demote=demote, cancelled=cancelled)
        if code != 0:raise RuntimeError(f'Original DeepSWE verifier exited {code}; no score accepted\n'+display_output(verifier / 'test-stdout.txt')[-6000:])
        reward = json.loads(checked_bytes(verifier / 'reward.json', 65536))
        ctrf = None if reward.get('apply_failed') == 1 else json.loads(checked_bytes(verifier / 'ctrf.json', 16 * 1024 * 1024))
        grading = 'passed' if reward.get('reward') == 1 else 'failed'
        validate_result(reward, ctrf, original, grading)
        return grading, display_output(verifier / 'test-stdout.txt')

    def recovery_evidence(self, root, job, grading, read_bytes):
        reward_data = read_bytes(root / 'logs/verifier/reward.json', 65536)
        reward = json.loads(reward_data)
        original_data = read_bytes(root / 'tests/config.json', 16 * 1024 * 1024)
        proof = {'logs/verifier/reward.json': hashlib.sha256(reward_data).hexdigest(),
                 'tests/config.json': hashlib.sha256(original_data).hexdigest()}
        ctrf = None
        if reward.get('apply_failed') != 1:
            data = read_bytes(root / 'logs/verifier/ctrf.json', 16 * 1024 * 1024)
            ctrf = json.loads(data);proof['logs/verifier/ctrf.json'] = hashlib.sha256(data).hexdigest()
        validate_result(reward, ctrf, json.loads(original_data), grading)
        patch_data = read_bytes(root / 'artifacts/model.patch', 16 * 1024 * 1024)
        manifest_data = read_bytes(root / 'patch-manifest.json', 65536);manifest = json.loads(manifest_data)
        if (manifest['baseCommit'] != job['deep']['baseCommit'] or manifest['bytes'] != len(patch_data)
                or manifest['sha256'] != hashlib.sha256(patch_data).hexdigest()):
            raise ValueError('DeepSWE exported patch changed')
        proof.update({'artifacts/model.patch': hashlib.sha256(patch_data).hexdigest(),
                      'patch-manifest.json': hashlib.sha256(manifest_data).hexdigest()})
        return proof
