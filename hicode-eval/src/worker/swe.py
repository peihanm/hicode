"""Host-owned SWE adapter. No gold patch; scoring uses pinned upstream harness."""
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import re
import ast
from urllib.parse import urlsplit
from protocol import atomic_json, namespace_argv

from venv_paths import ENV_MOUNT

# Native editable installs can validate existing build outputs for over a minute.
SOURCE_INSTALL_TIMEOUT_SECONDS = 300
SOURCE_ARCHIVE_CACHE = Path('/opt/hicode-swe/source-cache')


def requires_source_version(repo, version):
    return repo in {'pydata/xarray', 'pytest-dev/pytest', 'matplotlib/matplotlib'} or (
        repo == 'astropy/astropy' and version not in {'1.3', '3.1'})


def materialize_versioneer_source(project, repo, version):
    if repo != 'matplotlib/matplotlib' or version not in {'3.0', '3.1'}:
        return
    from scm import read_source_version
    receipt = read_source_version(project)
    match = re.fullmatch(r'v([0-9]+(?:\.[0-9]+)+)-([0-9]+)-g([a-f0-9]+)', receipt['describe'])
    if not match:
        raise ValueError('Unsupported original Versioneer description')
    tag, distance, short = match.groups()
    expected = f'{tag}+{distance}.g{short}'
    if receipt['version'] != expected or not receipt['baseCommit'].startswith(short):
        raise ValueError('Versioneer receipt differs from the original source commit')
    path = Path(project)/'lib/matplotlib/_version.py'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 100_000:
        raise ValueError('Missing original Versioneer source file')
    original = path.read_text()
    if 'git_refnames' not in original or 'get_versions' not in original:
        raise ValueError('Unexpected original Versioneer source file')
    payload = json.dumps({'version': expected, 'full-revisionid': receipt['baseCommit'],
                          'dirty': False, 'error': None}, sort_keys=True)
    path.write_text("import json\nversion_json = '''\n"+payload+"\n'''  # END VERSION_JSON\n\n"
                    "def get_versions():\n    return json.loads(version_json)\n")

def editable_install_argv(python, project, repo, version=None):
    if repo == 'astropy/astropy' and version in {'1.3', '3.1'}:
        return [str(python), 'setup.py', '--offline', 'develop']
    args = [str(python), '-m', 'pip', 'install', '--no-deps', '--no-build-isolation']
    extra = '[test]' if repo in ('sphinx-doc/sphinx', 'astropy/astropy') else '[dev]' if repo == 'mwaskom/seaborn' else ''
    if repo == 'scikit-learn/scikit-learn':
        args.append('--no-use-pep517')
    return [*args, '-e', str(project) + extra]


def project_environment(repo, project=None, version=None):
    # tox-current-env's fake Python links bypass venv discovery. Keep the same
    # public source and cached packages visible without changing test commands.
    if repo == 'sphinx-doc/sphinx':
        return {'PYTEST_ADDOPTS': '-rA', 'PYTHONPATH':'/testbed:'+ENV_MOUNT+'/lib/python3.9/site-packages'}
    if repo == 'astropy/astropy' and version in {'1.3', '3.1'}:
        return {}
    if requires_source_version(repo, version):
        if project is None: raise ValueError('SCM project requires verified upstream version metadata')
        from scm import read_source_version
        receipt = read_source_version(project)
        environment={'SETUPTOOLS_SCM_PRETEND_VERSION': receipt['version']}
        if repo == 'matplotlib/matplotlib':
            # setuptools 68's editable-wheel build uses temporary extension
            # paths. Preserve its reviewed develop cache across startup/replay.
            environment.update(SETUPTOOLS_ENABLE_FEATURES='legacy-editable',MPLBACKEND='Agg')
            if SOURCE_ARCHIVE_CACHE.exists():
                if SOURCE_ARCHIVE_CACHE.is_symlink() or not SOURCE_ARCHIVE_CACHE.is_dir():
                    raise ValueError('Invalid reviewed source archive cache')
                environment['XDG_CACHE_HOME'] = str(SOURCE_ARCHIVE_CACHE)
        return environment

    return {}


def snapshot(source, target):
    """Copy file objects without following symlinks or using Agent-controlled Git."""
    source, target = Path(source), Path(target)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Invalid repository root')
    target.mkdir()
    total = 0
    count = 0
    def walk(src, dst):
        nonlocal total, count
        for entry in sorted(os.scandir(src), key=lambda e: e.name):
            if entry.name == '.git':
                continue
            count += 1
            if count > 20000:
                raise ValueError('Repository file budget exceeded')
            mode = entry.stat(follow_symlinks=False).st_mode
            out = dst / entry.name
            if stat.S_ISLNK(mode):
                out.symlink_to(os.readlink(entry.path))
            elif stat.S_ISDIR(mode):
                out.mkdir(); walk(Path(entry.path), out)
            elif stat.S_ISREG(mode):
                fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError('Changed repository file')
                    total += info.st_size
                    if total > 512 * 1024 * 1024:
                        raise ValueError('Repository byte budget exceeded')
                    with out.open('xb') as output: shutil.copyfileobj(handle, output)
                    out.chmod(0o755 if info.st_mode & 0o111 else 0o644)
            else:
                raise ValueError('Special repository file cannot be exported')
    walk(source, target)


def git(args, cwd, input=None):
    # No user/global config, templates, hooks, alternates, or external diff programs.
    env = {'PATH': os.environ['PATH'], 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_AUTHOR_NAME': 'HiCode Eval', 'GIT_AUTHOR_EMAIL': 'eval@localhost',
           'GIT_COMMITTER_NAME': 'HiCode Eval', 'GIT_COMMITTER_EMAIL': 'eval@localhost'}
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
                                   '-c', 'core.fileMode=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'safe.directory=' + str(cwd), *args], cwd=cwd, env=env, stderr=subprocess.PIPE, input=input)


def export_patch(baseline, final):
    with tempfile.TemporaryDirectory(prefix='hicode-swe-export-') as tmp:
        trusted = Path(tmp) / 'repo'
        snapshot(baseline, trusted)
        git(['init', '--template='], trusted)
        git(['add', '-f', '-A'], trusted)
        git(['commit', '-qm', 'Prepared baseline', '--allow-empty'], trusted)
        other = Path(tmp) / 'final'; snapshot(final, other)
        # Only new, recognizable runtime artifacts are omitted. Existing
        # fixtures and arbitrary new source files ignore Actor .gitignore rules.
        baseline_paths = set()
        for directory, names, files in os.walk(baseline, followlinks=False):
            baseline_paths.update((Path(directory) / name).relative_to(baseline)
                                  for name in [*names, *files])
        # Use only the frozen repository's ignore rules. Build and test outputs
        # absent from that baseline are not a model patch; Actor-edited ignore
        # rules cannot hide new source files from export.
        candidates = {os.fsencode(str(path.relative_to(other))): path
                      for path in other.rglob('*')
                      if (path.is_symlink() or not path.is_dir()) and
                      path.relative_to(other) not in baseline_paths}
        if candidates:
            try:
                ignored = git(['check-ignore', '--no-index', '--stdin', '-z'], trusted,
                              b'\0'.join(candidates) + b'\0').split(b'\0')
            except subprocess.CalledProcessError as error:
                if error.returncode != 1: raise
                ignored = []
            for name in ignored:
                if name: candidates[name].unlink()
        for child in trusted.iterdir():
            if child.name == '.git': continue
            if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
            else: child.unlink()
        for name, marker, prefix in [
                ('.pytest_cache', 'CACHEDIR.TAG', b'Signature: 8a477f597d28d172789f06886806bc55'),
                ('.hypothesis', '.gitignore', b'# Automatically created by Hypothesis')]:
            path = other / name
            signature = path / marker
            if (Path(name) not in baseline_paths and path.is_dir() and not path.is_symlink() and
                    signature.is_file() and not signature.is_symlink() and
                    signature.stat().st_size < 4096 and signature.read_bytes().startswith(prefix)):
                shutil.rmtree(path)
        for directory, _, files in os.walk(other, followlinks=False):
            parent = Path(directory)
            if parent.name != '__pycache__':
                continue
            for name in files:
                path = parent / name
                if name.endswith(('.pyc', '.pyo')) and path.relative_to(other) not in baseline_paths:
                    path.unlink()
        for child in other.iterdir(): shutil.move(str(child), str(trusted / child.name))
        git(['add', '-f', '-A'], trusted)
        return git(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], trusted).decode('utf-8', errors='strict')


def verify_reviewed_test_dependencies(repo, version, project, grade_env, logs):
    """Validate prepared dependencies; grading never repairs the environment."""
    from reviewed_test_deps import reviewed_test_dependencies
    pins = reviewed_test_dependencies(repo, version, project)
    if not pins: return
    from importlib import metadata
    current = {pin.split('==')[0]:pin.split('==')[1] for pin in pins}
    needed = []
    # Inspect the copied environment's own metadata, never the host Python.
    program = '''import importlib.metadata as m,json,sys
def version(name):
    try:return m.version(name)
    except m.PackageNotFoundError:return None
print(json.dumps({name:version(name) for name in sys.argv[1:]}))'''
    # Distribution names are fixed by the reviewed table, not model input.
    probe = subprocess.run([str(grade_env/'bin/python'),'-c',program,*current],capture_output=True,text=True,check=True,timeout=20)
    installed = json.loads(probe.stdout)
    for pin in pins:
        name,version_pin = pin.split('==')
        if installed.get(name) != version_pin:needed.append(pin)
    atomic_json(logs/'dependency-conditions.json',{'source':'frozen public project declarations',
                'originalEnvironment':str(project),'required':pins,'missing':needed})
    if needed:raise ValueError('Prepared verifier dependencies differ from the reviewed recipe: '+', '.join(needed))


def supervise(argv, *, output, timeout, env, cwd, demote, cancelled):
    with output.open('w') as stream:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, preexec_fn=demote, start_new_session=True,
                                stdout=stream, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while proc.poll() is None:
                if cancelled(): raise RuntimeError('SWE verification cancelled')
                if time.monotonic() - started > timeout: raise RuntimeError('SWE verifier timed out')
                time.sleep(.1)
            return proc.returncode
        finally:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait()


def validate_swe_report(data, instance_id, expected_grade):
    if expected_grade not in {'passed','failed'} or set(data) != {instance_id}:raise ValueError('Invalid SWE report identity')
    item=data[instance_id]
    if any(type(item.get(k)) is not bool for k in ['patch_is_None','patch_exists','patch_successfully_applied','resolved']):raise ValueError('Invalid official SWE report')
    if item['patch_is_None'] or not item['patch_exists']:raise ValueError('Missing SWE prediction')
    if (expected_grade=='passed') != item['resolved']:raise ValueError('SWE grade and report disagree')
    if item['resolved']:
        for group in ['FAIL_TO_PASS','PASS_TO_PASS']:
            result=item.get('tests_status',{}).get(group)
            if not isinstance(result,dict) or result.get('failure')!=[] or not isinstance(result.get('success'),list):raise ValueError('Incomplete SWE success report')
        if not item['patch_successfully_applied']:raise ValueError('Unapplied SWE patch cannot pass')



def namespace_eval_commands(commands, repo, version):
    result=[]
    for command in commands:
        if repo == 'django/django' and (command == './tests/runtests.py' or command.startswith('./tests/runtests.py ')):
            result.append('python /tests/hicode_django_report.py ' + command)
            continue
        if repo == 'astropy/astropy' and version in {'1.3','3.1'} and command == 'python -m pip install -e .[test] --verbose':
            result.append('python setup.py --offline develop')
            continue
        if command.startswith('source /opt/miniconda3/bin/activate') or command.startswith('conda activate '):
            continue
        if repo in ('pydata/xarray','pytest-dev/pytest','pylint-dev/pylint','pallets/flask','matplotlib/matplotlib') and command=='python -m pip install -e .':
            # Both phases use the same cached dependencies and SCM backend.
            # Rebuilding in an isolated env would resolve another toolchain.
            result.append('python -m pip install --no-deps --no-build-isolation -e .')
            continue
        install = {
            'astropy/astropy': 'python -m pip install -e .[test] --verbose',
            'psf/requests': 'python -m pip install .',
            'mwaskom/seaborn': 'python -m pip install -e .[dev]',
            'scikit-learn/scikit-learn': 'python -m pip install -v --no-use-pep517 --no-build-isolation -e .',
        }.get(repo)
        if command == install:
            # Rebuild the patched project with the already prepared toolchain.
            result.append(command.replace('pip install ', 'pip install --no-deps ' +
                ('' if '--no-build-isolation' in command else '--no-build-isolation '), 1))
            continue
        if (repo=='django/django' and version in {'3.0', '3.1', '3.2'} and
            command=="sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen"):
            # Locale generation belongs to trusted preparation. The read-only
            # grader checks that same precondition instead of writing /etc.
            result.append('locale -a | grep -Fxq en_US.utf8 || exit 1')
        else:result.append(command)
    return result


def xarray_arm_reporting(project):
    """Recognize the original platform marker before enabling the narrow reporter."""
    if platform.machine() not in {'aarch64','arm64'}:return False
    project=Path(project)
    marker=project/'xarray/tests/__init__.py'
    tests=project/'xarray/tests/test_duck_array_ops.py'
    if not marker.is_file() or not tests.is_file():return False
    definitions=ast.parse(marker.read_text())
    valid=False
    expected=ast.parse('pytest.mark.xfail(platform.machine() == "aarch64" or "arm" in platform.machine(), reason="expected failure on ARM")',mode='eval').body
    for node in definitions.body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='arm_xfail' for t in node.targets):
            valid=ast.dump(node.value)==ast.dump(expected)
    for node in ast.parse(tests.read_text()).body:
        if isinstance(node,ast.FunctionDef) and node.name=='test_datetime_mean':
            return valid and any(isinstance(d,ast.Name) and d.id=='arm_xfail' for d in node.decorator_list)
    return False


def official_test_paths(patch, project):
    """Confine the frozen official patch to repository paths, regardless of directory name."""
    if not isinstance(patch, str) or not patch or len(patch.encode()) > 4 * 1024 * 1024:
        raise ValueError('Invalid official test patch')
    fields = git(['apply', '--numstat', '-z', '-'], project, patch.encode()).split(b'\0')
    paths = []
    index = 0
    while index < len(fields) and fields[index]:
        parts = fields[index].split(b'\t', 2); index += 1
        if len(parts) != 3: raise ValueError('Invalid official patch path report')
        names = [parts[2]]
        if not parts[2]:
            if index + 1 >= len(fields): raise ValueError('Incomplete official patch rename')
            names = fields[index:index + 2]; index += 2
        for name in names:
            value = name.decode('utf-8', errors='strict')
            path = Path(value)
            if (path.is_absolute() or not value or str(path) != value or
                    any(c in value for c in '\0\n\r\t') or
                    any(p in {'.', '..', '.git'} for p in path.parts)):
                raise ValueError('Official patch path is outside repository boundaries: ' + repr(value))
            paths.append(value)
    if not paths: raise ValueError('Official patch has no test paths')
    return sorted(set(paths))


def restore_official_test_paths(project, baseline_commit, patch):
    """Only the disposable grader tree is changed; no Agent tree or patch is edited."""
    project = Path(project)
    if project.is_symlink() or not re.fullmatch(r'[a-f0-9]{40}', baseline_commit):
        raise ValueError('Invalid grading baseline')
    paths = official_test_paths(patch, project)
    tracked = []
    for name in paths:
        target = project / name
        for parent in target.parents:
            if parent == project: break
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                raise ValueError('Test reset parent is not a safe directory: ' + name)
        entry = git(['ls-tree', '-z', baseline_commit, '--', name], project)
        if entry:
            if not entry.startswith((b'100644 blob ', b'100755 blob ')):
                raise ValueError('Official test baseline is not a regular file: ' + name)
            tracked.append(name)
    # The Host-validated official patch may include test support inside the library.
    # Reset only its declared paths, never the whole tree or unrelated model changes.
    for name in paths:
        target = project / name
        if target.is_symlink() or target.is_file(): target.unlink()
        elif target.exists(): raise ValueError('Official test path became a directory: ' + name)
    if tracked: git(['restore', '--source=' + baseline_commit, '--worktree', '--', *tracked], project)
    return paths


def controlled_eval_script(commands, baseline_commit, test_patch):
    """Keep the original test command, replacing only unsafe test reset/replay."""
    result = []
    applied = 0
    for command in commands:
        if command.startswith('git checkout '):
            if not command.startswith('git checkout ' + baseline_commit):
                raise ValueError('Unexpected official test reset command')
            continue
        if command.startswith('git apply '):
            match = re.fullmatch(r"git apply -v - <<'([A-Za-z0-9_]+)'\n(.*)\n\1", command, re.S)
            if not match or match.group(2) != test_patch: raise ValueError('Unexpected official test patch command')
            applied += 1
            continue
        result.append(command)
    start = ": '>>>>> Start Test Output'"
    end = ": '>>>>> End Test Output'"
    if applied != 1 or result.count(start) != 1 or result.count(end) != 1:
        raise ValueError('Unsupported official verifier phase boundaries')
    a, b = result.index(start), result.index(end)
    if a >= b or b != len(result) - 1 or b == a + 1:
        raise ValueError('Invalid official verifier phases')
    return ('#!/bin/bash\nset -euxo pipefail\n' + '\n'.join(result[:a]) + '\n' + start +
            '\nset +e\n(\nset -e\n' + '\n'.join(result[a + 1:b]) +
            '\n)\nhicode_test_exit=$?\n' + end + '\nexit "$hicode_test_exit"\n')


def normalize_django_log(log, expected):
    """Append canonical unittest outcomes for the upstream parser; keep raw output intact."""
    start_marker, end_marker = '>>>>> Start Test Output', '>>>>> End Test Output'
    if log.count(start_marker) != 1 or log.count(end_marker) != 1:
        return log
    start, end = log.index(start_marker) + len(start_marker), log.index(end_marker)
    if start >= end:
        return log
    wanted = set(expected)
    statuses = {}
    aliases = {}
    current = None
    failure = None
    header = re.compile(r'(test\S* \([^()\n]+\))')
    priority = {'PASSED': 0, 'SKIPPED': 1, 'FAILED': 2, 'ERROR': 3}
    body_errors = set()
    for section in re.split(r'^=+\s*$', log[start:end], flags=re.MULTILINE):
        error = re.match(r'\s*ERROR: (test\S* \([^()\n]+\))', section)
        if not error:
            continue
        name = error.group(1)
        method = name.split(' ', 1)[0]
        # A named case with its own test-body frame has executed and failed.
        # Loader, setUp and tearDown errors remain unavailable; error wording
        # (AttributeError, SQL errors, etc.) is not used to guess attribution.
        frame = r'^  File "/testbed/tests/[^"\n]+", line \d+, in ' + re.escape(method) + r'\s*$'
        if re.search(frame, section, re.MULTILINE):
            body_errors.add(name)

    def record(name, status):
        if name and priority[status] >= priority.get(statuses.get(name), -1):
            statuses[name] = status

    for raw in log[start:end].splitlines():
        line = raw.strip()
        detail = re.match(r'^(FAIL|ERROR): (test\S* \([^()\n]+\))', line)
        if detail:
            current = detail.group(2)
            failure = 'FAILED' if detail.group(1) == 'FAIL' else 'ERROR'
            record(current, failure)
            for alias in aliases.get(current, ()):
                record(alias, failure)
            continue
        # A failed subTest has no inline verdict: the next test can start on the
        # same line. Only the last test on that line owns its trailing verdict.
        matches = [match for match in header.finditer(line)
                   if match.start() == 0 or line[:match.start()].endswith(' ... ')]
        if matches:
            description = line.split(' ... ', 1)[0]
            if matches[0].start() and current and description in wanted:
                aliases.setdefault(current, set()).add(description)
            current = matches[-1].group(1)
            failure = None
            tail = line[matches[-1].end():].strip()
        else:
            tail = line
            description = line.split(' ... ', 1)[0]
            if current and description in wanted:
                aliases.setdefault(current, set()).add(description)
                if failure:
                    record(description, failure)
        verdict = re.fullmatch(r'(?:\.\.\.\s+)?(ok|OK|FAIL|ERROR|skipped(?:\s+.*)?)', tail)
        if verdict and current and not failure:
            value = verdict.group(1)
            status = ('PASSED' if value in ('ok', 'OK') else
                      'SKIPPED' if value.startswith('skipped') else
                      'FAILED' if value == 'FAIL' else 'ERROR')
            record(current, status)
            for alias in aliases.get(current, ()):
                record(alias, status)
            current = None
        elif ' ... ' in tail and current and not failure:
            # Descriptive test IDs occupy a separate line in unittest output.
            description, value = tail.rsplit(' ... ', 1)
            if description in wanted and value in ('ok', 'OK', 'FAIL', 'ERROR'):
                status = {'ok': 'PASSED', 'OK': 'PASSED', 'FAIL': 'FAILED', 'ERROR': 'ERROR'}[value]
                record(current, status)
                record(description, status)
                current = None
    suffix = {'PASSED': 'ok', 'FAILED': 'FAIL', 'ERROR': 'ERROR', 'SKIPPED': 'skipped'}
    for name in body_errors:
        for alias in {name, *aliases.get(name, ())}:
            if statuses.get(alias) == 'ERROR':
                statuses[alias] = 'FAILED'
    recovered = [f'{name} ... {suffix[statuses[name]]}' for name in sorted(wanted) if name in statuses]
    return log[:end] + '\n\n' + '\n'.join(recovered) + '\n' + log[end:] if recovered else log


def read_verifier_log(path):
    """Decode verifier output for the upstream parser without changing raw evidence."""
    return Path(path).read_bytes().decode('utf-8', errors='replace')


def normalize_sympy_log(text):
    # SymPy's runner emits E after executing a test body that raised. Unlike
    # pytest collection/setup ERROR, this is a completed failing test.
    return re.sub(r'^(test_[A-Za-z0-9_]+) E$', r'\1 F', text, flags=re.MULTILINE)


def verification_validity(spec, statuses, parsed, exit_code):
    expected = list(dict.fromkeys([*spec.FAIL_TO_PASS, *spec.PASS_TO_PASS]))
    if not spec.FAIL_TO_PASS or not parsed or exit_code not in (0, 1):
        return False, 'Original verifier did not start or finish normally'
    unresolved = [name for name in expected if statuses.get(name) not in {'PASSED', 'FAILED'}]
    if unresolved: return False, 'Original target/regression results are missing, skipped, or errored: ' + ', '.join(unresolved[:8])
    return True, None


def verify_swe(root, config, uid, gid, cancelled):
    """Seal the prediction once, then use the same grader as offline rechecks."""
    root = Path(root)
    patch = export_patch(root / 'baseline', root / 'project')
    prediction = {'instance_id': config['swe']['instanceId'], 'model_name_or_path': config['model']['model'], 'model_patch': patch}
    atomic_json(root / 'prediction.json', prediction)
    atomic_json(root / 'patch-manifest.json', {'sha256': hashlib.sha256(patch.encode()).hexdigest(),
                'baseCommit': config['swe']['baseCommit'], 'baselineCommit': config['swe']['baselineCommit'],
                'revision': config['swe']['revision'], 'method': 'host-owned-tree-diff'})
    return grade_swe_patch(root, config, uid, gid, cancelled, patch)


def verifier_log_directory(root):
    logs = Path(root) / 'logs' / 'verifier'
    if logs.is_symlink() or (logs.exists() and not logs.is_dir()):
        raise ValueError('Verifier log path is not a directory')
    # The runner creates this directory before invoking the SWE grader.
    logs.mkdir(mode=0o755, parents=True, exist_ok=True)
    if any(logs.iterdir()):
        raise ValueError('Verifier log directory already contains evidence')
    return logs


def verifier_proxy_environment(proxy):
    if proxy is None:
        return {}
    if not isinstance(proxy, str) or len(proxy) > 2048:
        raise ValueError('Invalid verifier proxy')
    url = urlsplit(proxy)
    if (url.scheme not in {'http', 'https'} or not url.hostname or url.username is not None or
            url.password is not None or url.path not in {'', '/'} or url.query or url.fragment or
            any(c.isspace() or ord(c) < 32 for c in proxy)):
        raise ValueError('Verifier proxy must be an HTTP(S) origin without credentials')
    # Original suites run local HTTP servers; they must never traverse the proxy.
    return {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'NO_PROXY': 'localhost,127.0.0.1,::1'}


def grade_swe_patch(root, config, uid, gid, cancelled, patch):
    """Replay an immutable prediction in a fresh Host-owned grading workspace."""
    root = Path(root)
    logs = verifier_log_directory(root)
    prediction = {'instance_id': config['swe']['instanceId'], 'model_name_or_path': config['model']['model'], 'model_patch': patch}
    row = json.loads((root / 'tests' / 'evaluation.json').read_text())
    if row['instance_id'] != prediction['instance_id'] or row['base_commit'] != config['swe']['baseCommit'] or 'patch' in row:
        raise ValueError('SWE grading identity mismatch or gold material present')
    work = root / 'grading-project'
    shutil.copytree(root / 'baseline', work, symlinks=True)
    grade_env = Path('/opt/hicode-swe/verifier')
    if not (grade_env/'.ready.json').is_file():raise ValueError('Prepared verifier environment is missing')
    verify_reviewed_test_dependencies(config['swe']['repo'],row['version'],root/'baseline',grade_env,logs)
    grade_home = root / 'grading-home'; grade_home.mkdir()
    subprocess.run(['chown', '-R', f'{uid}:{gid}', str(work), str(grade_env), str(grade_home), str(root/'tests')], check=True)
    def demote(): os.setgroups([]); os.setgid(gid); os.setuid(uid)
    env = {'PATH': ENV_MOUNT+'/bin:'+os.environ['PATH'], 'HOME': str(grade_home), 'LANG': 'C.UTF-8',
           'VIRTUAL_ENV': ENV_MOUNT, 'PYTHONDONTWRITEBYTECODE':'1', 'PIP_DISABLE_PIP_VERSION_CHECK':'1'}
    env.update(project_environment(config['swe']['repo'],root/'baseline',config['swe']['version']))
    env.update(verifier_proxy_environment(config.get('verifierProxy')))
    if requires_source_version(config['swe']['repo'], config['swe']['version']):
        from scm import read_source_version
        read_source_version(root/'baseline', config['swe']['baseCommit'])
    args = namespace_argv(['git','apply','--whitespace=nowarn','/tests/model.patch'], work, grade_home,
                          root/'logs', root/'control-placeholder', root/'tests', workdir='/testbed', environment=grade_env, readonly_logs=True)
    # Patch replay happens after stopping every Actor process. Hidden data is only in this view.
    (root/'tests'/'model.patch').write_text(patch)
    (root/'control-placeholder').mkdir(exist_ok=True)
    if patch:
        code = supervise(args, output=logs/'patch-apply.txt', timeout=30, env=env, cwd=work, demote=demote, cancelled=cancelled)
        if code:
            atomic_json(logs/'report.json',{prediction['instance_id']:{'patch_is_None':False,'patch_exists':True,'patch_successfully_applied':False,'resolved':False}})
            return 'unavailable', 'Exported patch could not be replayed on the protected prepared baseline; no tests executed.'
    test_paths = restore_official_test_paths(work, config['swe']['baselineCommit'], row['test_patch'])
    (root/'tests/test.patch').write_text(row['test_patch'])
    args = namespace_argv(['git', 'apply', '--whitespace=nowarn', '/tests/test.patch'], work, grade_home,
                          root/'logs', root/'control-placeholder', root/'tests', workdir='/testbed', environment=grade_env, readonly_logs=True)
    code = supervise(args, output=logs/'test-patch-apply.txt', timeout=30, env=env, cwd=work, demote=demote, cancelled=cancelled)
    atomic_json(logs/'test-patch.json', {'sha256': hashlib.sha256(row['test_patch'].encode()).hexdigest(), 'paths': test_paths, 'applied': code == 0})
    if code: return 'unavailable', 'Original test patch could not be applied; no target tests executed. See test-patch-apply.txt.'
    # Upstream script needs a reachable clean commit for resetting test files. Our prepared
    # Git baseline has precisely the original source plus installation bookkeeping.
    from swebench.harness.test_spec.test_spec import TestSpec
    from swebench.harness.test_spec.python import make_eval_script_list_py
    from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS
    from swebench.harness.grading import get_eval_report, get_logs_eval
    official = dict(row); official['base_commit'] = config['swe']['baselineCommit']
    commands = make_eval_script_list_py(official,MAP_REPO_VERSION_TO_SPECS[row['repo']][row['version']],
                                       'testbed','/testbed',official['base_commit'],row['test_patch'])
    spec = TestSpec(instance_id=row['instance_id'],repo=row['repo'],version=row['version'],repo_script_list=[],
                    eval_script_list=commands,env_script_list=[],arch='arm64' if platform.machine()=='aarch64' else 'x86_64',
                    FAIL_TO_PASS=json.loads(row['FAIL_TO_PASS']) if isinstance(row['FAIL_TO_PASS'],str) else row['FAIL_TO_PASS'],
                    PASS_TO_PASS=json.loads(row['PASS_TO_PASS']) if isinstance(row['PASS_TO_PASS'],str) else row['PASS_TO_PASS'],
                    language='py',docker_specs={},namespace=None)
    commands = namespace_eval_commands(spec.eval_script_list,row['repo'],row['version'])
    if row['repo'] == 'django/django':
        reporter = root/'tests/hicode_django_report.py'
        shutil.copyfile(Path(__file__).with_name('django_report.py'), reporter)
        reporter.chmod(0o644)
    if row['repo']=='pydata/xarray' and row['version']=='0.12' and xarray_arm_reporting(root/'baseline'):
        reporter=root/'tests/hicode_platform_report.py'
        shutil.copyfile(Path(__file__).with_name('xarray_report.py'),reporter);reporter.chmod(0o644)
        env['PYTHONPATH']='/tests'
        commands=[command+' -p hicode_platform_report' if command.startswith('pytest ') else command for command in commands]
    script = controlled_eval_script(commands, config['swe']['baselineCommit'], row['test_patch'])
    (root/'tests'/'eval.sh').write_text(script)
    argv = namespace_argv(['bash','/tests/eval.sh'], work, grade_home, root/'logs', root/'control-placeholder',
                          root/'tests', workdir='/testbed', environment=grade_env, readonly_logs=True)
    code = supervise(argv, output=logs/'output.txt', timeout=config['verifierSeconds'], env=env, cwd=work, demote=demote, cancelled=cancelled)
    parsed_output = logs/'parsed-output.txt'
    raw_log = read_verifier_log(logs/'output.txt')
    if row['repo'] == 'django/django':
        parsed_output.write_text(normalize_django_log(raw_log,
                                                     [*spec.FAIL_TO_PASS, *spec.PASS_TO_PASS]))
    elif row['repo'] == 'sympy/sympy':
        parsed_output.write_text(normalize_sympy_log(raw_log))
    else:
        parsed_output.write_text(raw_log)
    statuses, parsed = get_logs_eval(spec, str(parsed_output))
    valid, reason = verification_validity(spec, statuses, parsed, code)
    atomic_json(logs/'validity.json', {'valid': valid, 'reason': reason, 'exitCode': code,
                'targetTests': spec.FAIL_TO_PASS, 'regressionTests': spec.PASS_TO_PASS,
                'actual': {name: statuses.get(name) for name in [*spec.FAIL_TO_PASS, *spec.PASS_TO_PASS]}})
    report = get_eval_report(spec, prediction, str(parsed_output), include_tests_status=True)
    atomic_json(logs/'report.json', report)
    if not valid: return 'unavailable', reason + '; see verifier/output.txt and validity.json.'
    item = report[prediction['instance_id']]
    if not item['patch_successfully_applied']:
        return 'unavailable', 'Official test output incomplete; see verifier/output.txt and report.json.'
    grade = 'passed' if item['resolved'] else 'failed'
    validate_swe_report(report,prediction['instance_id'],grade)
    return grade, json.dumps(report, ensure_ascii=False, indent=2)
