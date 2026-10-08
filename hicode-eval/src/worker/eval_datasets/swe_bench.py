"""SWE-bench Verified runtime setup and grading."""
import os
import hashlib
import json
from pathlib import Path

class SweBenchRuntime:
    workdir = '/testbed'
    actor_environment = Path('/opt/hicode-swe/actor')
    verifier_root = None

    def public_test_entries(self, config):
        return {
            'django/django': ['/testbed/tests/（原仓库公开测试）'],
            'sympy/sympy': ['/testbed/sympy/**/tests/', '/testbed/bin/test'],
            'pytest-dev/pytest': ['/testbed/testing/'],
            'pydata/xarray': ['/testbed/xarray/tests/'],
            'sphinx-doc/sphinx': ['/testbed/tests/'],
            'astropy/astropy': ['/testbed/astropy/**/tests/'],
            'scikit-learn/scikit-learn': ['/testbed/sklearn/**/tests/'],
            'pylint-dev/pylint': ['/testbed/tests/'],
            'psf/requests': ['/testbed/test_requests.py', '/testbed/tests/'],
            'pallets/flask': ['/testbed/tests/'],
            'mwaskom/seaborn': ['/testbed/tests/'],
            'matplotlib/matplotlib': ['/testbed/lib/matplotlib/tests/'],
        }[config['swe']['repo']]

    def writable_tests(self, config):
        return False

    def workspace_aliases(self, config):
        return []

    def writable_runtime_bin(self, config):
        return False

    def command_environment(self, config, home, root):
        from swe import project_environment
        environment = project_environment(config['swe']['repo'], root / 'baseline', config['swe']['version'])
        environment.update(PATH='/opt/hicode-swe/env/bin:' + str(home / '.local/bin') + ':' + str(home / 'bin') + ':' + os.environ['PATH'],
                           VIRTUAL_ENV='/opt/hicode-swe/env', PYTHONDONTWRITEBYTECODE='1')
        return environment

    def prepare_actor(self, config, project, logs, command, namespace):
        if not (self.actor_environment / '.ready.json').is_file():
            raise ValueError('Prepared actor environment is missing')
        from swe import editable_install_argv, materialize_versioneer_source, SOURCE_INSTALL_TIMEOUT_SECONDS
        root = project.parent
        materialize_versioneer_source(root / 'baseline', config['swe']['repo'], config['swe']['version'])
        materialize_versioneer_source(project, config['swe']['repo'], config['swe']['version'])
        command(namespace(editable_install_argv('/opt/hicode-swe/env/bin/python', '/testbed', config['swe']['repo'], config['swe']['version'])),
                timeout=SOURCE_INSTALL_TIMEOUT_SECONDS, output_path=logs / 'repo-install.txt')

    def grade(self, *, root, config, uid, gid, project, home, logs, command, namespace, demote, cancelled):
        from swe import verify_swe
        return verify_swe(root, config, uid, gid, cancelled)

    def recovery_evidence(self, root, job, grading, read_bytes):
        from swe import validate_swe_report
        report=read_bytes(root/'logs/verifier/report.json',16*1024*1024)
        validate_swe_report(json.loads(report),job['swe']['instanceId'],grading)
        prediction_data=read_bytes(root/'prediction.json',16*1024*1024)
        manifest_data=read_bytes(root/'patch-manifest.json',65536)
        prediction=json.loads(prediction_data)
        manifest=json.loads(manifest_data)
        if prediction['instance_id']!=job['swe']['instanceId'] or hashlib.sha256(prediction['model_patch'].encode()).hexdigest()!=manifest['sha256']:
            raise ValueError('SWE exported patch changed')
        return {'logs/verifier/report.json':hashlib.sha256(report).hexdigest(),
                'prediction.json':hashlib.sha256(prediction_data).hexdigest(),
                'patch-manifest.json':hashlib.sha256(manifest_data).hexdigest()}
