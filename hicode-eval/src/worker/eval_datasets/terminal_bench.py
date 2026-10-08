"""Terminal-Bench runtime setup and original pytest grading."""
import shutil
import subprocess
import hashlib
import json
import os
import tempfile
import time
import re
from pathlib import Path
from protocol import prepare_verifier_root
from verifier import verify, verifier_environment, validate_report_data

class TerminalBenchRuntime:
    workdir = '/app'
    actor_environment = None

    def public_test_entries(self, config):
        return ['/tests/' + entry['target'] for entry in config.get('publicTestInputs', [])]

    def __init__(self):
        self.verifier_root = None

    def writable_tests(self, config):
        writable=config.get('verifierWritableTests',False)
        if type(writable) is not bool:
            raise ValueError('Invalid writable verifier declaration')
        return writable or config['verifierPrelude'] == 'compile-feal-extension'

    def workspace_aliases(self, config):
        return config.get('workspaceAliases', [])

    def writable_runtime_bin(self, config):
        return config.get('writableRuntimeBin', False)

    def command_environment(self, config, home, root):
        environment = {}
        if config.get('packages'):
            environment['PYTHONPATH'] = '/opt/hicode-terminal/actor'
            environment['PIP_CACHE_DIR'] = '/tmp/pip-cache'
        return environment

    def prepare_actor(self, config, project, logs, command, namespace):
        if self.writable_runtime_bin(config):
            target=project/'runtime-bin'
            if target.exists() or target.is_symlink():
                raise ValueError('Reserved runtime executable directory already exists')
            shutil.copytree('/usr/local/bin', target, symlinks=True)
            owner=project.stat()
            subprocess.run(['chown','-hR',f'{owner.st_uid}:{owner.st_gid}',str(target)],check=True)
        for required in config.get('commands', []):
            if not shutil.which(required):
                raise RuntimeError('Task environment missing command: ' + required)
        if config.get('packages') and not Path('/opt/hicode-terminal/actor').is_dir():
            raise ValueError('Prepared actor packages are missing')
        initializer = config['initializer']
        if initializer:
            script = project / initializer['file']
            app_script = '/app/' + initializer['file']
            if initializer['kind'] == 'python':
                argv = ['/opt/python313/bin/python3.13', app_script]
            elif initializer['kind'] == 'bash':
                argv = ['bash', app_script]
            else:
                argv = ['gzip', '-d', '--', app_script]
            command(namespace(argv), timeout=30, output_path=logs / 'initializer.txt')
            script.unlink(missing_ok=True)

    def grade(self, *, root, config, uid, gid, project, home, logs, command, namespace, demote, cancelled):
        started=time.monotonic()
        def remaining():
            seconds=config['verifierSeconds']-(time.monotonic()-started)
            if seconds<=0:
                raise TimeoutError('Original verifier time budget exhausted')
            return seconds
        verifier_log = logs / 'verifier'
        total=0
        inputs=config.get('verifierInputs', [])
        pattern=r'(?:[A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*'
        if not isinstance(inputs,list) or len(inputs)>32:
            raise ValueError('Invalid verifier input declarations')
        targets=set()
        for entry in inputs:
            if (not isinstance(entry,dict) or set(entry)!={'source','target'}
                    or any(not isinstance(entry[key],str) or not re.fullmatch(pattern,entry[key]) for key in ['source','target'])
                    or not entry['source'].startswith('tests/') or entry['target'] in targets
                    or entry['target']=='runtime-bin' or entry['target'].startswith('runtime-bin/')):
                raise ValueError('Invalid verifier input path')
            targets.add(entry['target'])
            source=root/entry['source']
            if source.is_symlink() or not source.is_file():
                raise ValueError('Invalid frozen verifier input')
            for parent in source.parents:
                if parent==root:break
                if parent.is_symlink():raise ValueError('Verifier input source parent is a symlink')
            total+=source.stat().st_size
            if total>128*1024*1024:
                raise ValueError('Verifier input budget exceeded')
            target=project/entry['target']
            for parent in [target,*target.parents]:
                if parent==project:break
                if parent.is_symlink():raise ValueError('Verifier input destination is a symlink')
            target.parent.mkdir(parents=True,exist_ok=True)
            for parent in target.parents:
                if parent==project:break
                os.chown(parent,uid,gid)
            with tempfile.NamedTemporaryFile(dir=target.parent,delete=False) as temporary:
                name=temporary.name
                try:
                    with source.open('rb') as original:shutil.copyfileobj(original,temporary)
                    temporary.flush();os.fsync(temporary.fileno());os.chown(name,uid,gid)
                    os.replace(name,target)
                finally:
                    Path(name).unlink(missing_ok=True)
        verifier_packages = config.get('verifierPackages', [])
        if verifier_packages:
            if not Path('/opt/hicode-terminal/verifier').is_dir():
                raise ValueError('Prepared verifier packages are missing')
            target = project / '.eval-verifier-python'
            if target.exists() or target.is_symlink():
                raise ValueError('Reserved verifier dependency path already exists in the submitted workspace')
            if config.get('verifierChroot'):
                shutil.copytree('/opt/hicode-terminal/verifier', target, symlinks=True)
                subprocess.run(['chown', '-R', f'{uid}:{gid}', str(target)], check=True)
        if config.get('verifierChroot'):
            self.verifier_root = root / 'verifier-root'
            prepare_verifier_root(project, self.verifier_root)
            subprocess.run(['chown', '-R', f'{uid}:{gid}', str(self.verifier_root)], check=True)
            command(namespace(['/opt/python313/bin/python3.13', '-c',
                "import os,tempfile; f=tempfile.NamedTemporaryFile(dir='/app',delete=False);f.close(); dest='/tmp/'+os.path.basename(f.name);os.rename(f.name,dest);os.unlink(dest);os.chroot('/');assert os.getuid()==0"], verifier=True),
                timeout=15, output_path=verifier_log / 'namespace-check.txt')
        if config['verifierPrelude'] == 'reset-large-csv':
            command(namespace(['bash', '-c', 'rm -f -- /app/*.csv && /opt/python313/bin/python3.13 /tests/gen_large_csv.py input'], verifier=True), timeout=30)
        if config['verifierPrelude'] == 'copy-test-helper':
            command(namespace(['cp', '/tests/test.py', '/app/test.py'], verifier=True))
        if config['verifierPrelude'] == 'compile-feal-extension':
            subprocess.run(['chown', '-R', f'{uid}:{gid}', str(root / 'tests')], check=True)
            command(namespace(['--chdir', '/tests', '/opt/hicode-verifier/bin/python', '-s', '-P', 'setup.py', 'build_ext', '--inplace'], verifier=True, setup=True),
                    timeout=60, extra={'PYTHONPATH': '/app/.eval-verifier-python' if config.get('verifierChroot') else '/opt/hicode-terminal/verifier', 'PYTHONNOUSERSITE': '1'}, output_path=verifier_log / 'setup.txt')
        elif self.writable_tests(config):
            subprocess.run(['chown', '-R', f'{uid}:{gid}', str(root / 'tests')], check=True)
        if config.get('verifierSetup'):
            if not isinstance(config['verifierSetup'],str) or not re.fullmatch(pattern,config['verifierSetup']):
                raise ValueError('Invalid verifier setup path')
            command(namespace(['bash','/tests/'+config['verifierSetup']],verifier=True),
                    timeout=remaining(),
                    extra={**verifier_environment(config,home),**config.get('verifierEnvironment',{})},output_path=verifier_log/'setup.txt')
        paths=config.get('verifierTestPaths',['/tests/test_outputs.py'])
        if (not isinstance(paths,list) or not 1<=len(paths)<=32
                or any(not isinstance(path,str) or not re.fullmatch(r'/(?:app|tests)(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*',path) for path in paths)):
            raise ValueError('Invalid verifier test paths')
        python=config.get('verifierPython','/opt/hicode-verifier/bin/python')
        if python not in ['/opt/hicode-verifier/bin/python','/opt/hicode-task/verifier/bin/python']:
            raise ValueError('Invalid verifier interpreter')
        return verify(namespace([python, '-m', 'pytest', '-o', 'cache_dir=/logs/verifier/.pytest_cache', '--ctrf', '/logs/verifier/ctrf.json', *paths, '-rA'], verifier=True),
            timeout=remaining(), output_path=verifier_log / 'output.txt', report_path=verifier_log / 'ctrf.json', cwd=project,
            env={**verifier_environment(config, home), **config.get('verifierEnvironment', {})},
            preexec_fn=demote, cancelled=cancelled)

    def recovery_evidence(self, root, job, grading, read_bytes):
        report=read_bytes(root/'logs/verifier/ctrf.json',16*1024*1024)
        validate_report_data(json.loads(report),0 if grading=='passed' else 1)
        return {'logs/verifier/ctrf.json':hashlib.sha256(report).hexdigest()}
