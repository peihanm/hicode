import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
from protocol import namespace_argv, prepare_verifier_root

class NamespaceTest(unittest.TestCase):
    def test_writable_runtime_bin_is_private_and_does_not_grant_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            project=Path(tmp)/'project';(project/'runtime-bin').mkdir(parents=True)
            for tests in (None,'/tests'):
                argv=namespace_argv(['python'],project,'/h','/l','/c',tests,writable_runtime_bin=True)
                index=argv.index(str(project/'runtime-bin'))
                self.assertEqual(argv[index-1:index+2],['--bind',str(project/'runtime-bin'),'/usr/local/bin'])
                self.assertNotIn('--uid',argv)
                self.assertNotIn('--cap-add',argv)
            (project/'runtime-bin').rmdir();(project/'runtime-bin').symlink_to('/usr/local/bin')
            with self.assertRaisesRegex(ValueError,'Invalid runtime executable directory'):
                namespace_argv(['python'],project,'/h','/l','/c',writable_runtime_bin=True)

    def test_original_paths_alias_only_the_same_attempt_workspace(self):
        for tests in (None, '/eval/a/tests'):
            argv=namespace_argv(['python'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a',tests,
                                workspace_aliases=['/data','/workspace','/tmp/CompCert'])
            links=[argv[i+1:i+3] for i,flag in enumerate(argv) if flag=='--symlink']
            self.assertEqual(links,[['/app/data','/data'],['/app','/workspace'],['/app/CompCert','/tmp/CompCert']])
            self.assertNotIn('/eval/other/project',argv)
            self.assertNotIn('--uid',argv)
        for aliases in (['/etc'],['/eval'],['/data/../etc'],['/data','/data'],[{}],'/data'):
            with self.assertRaises(ValueError):
                namespace_argv(['python'],'/p','/h','/l','/c',workspace_aliases=aliases)
        with self.assertRaises(ValueError):
            namespace_argv(['python'],'/p','/h','/l','/c',workdir='/testbed',workspace_aliases=['/data'])

    def test_task_keeps_app_path_and_does_not_mount_tests(self):
        a=namespace_argv(['bun','entry.ts'],'/eval/runs/a/project','/eval/runs/a/home','/eval/runs/a/logs','/run/a')
        self.assertIn('--unshare-user',a)
        self.assertEqual(a[a.index('--ro-bind')+1:a.index('--ro-bind')+3],['/','/'])
        self.assertIn('/app',a);self.assertNotIn('/tests',a)
        self.assertEqual(a[-2:],['bun','entry.ts'])

    def test_independent_tasks_share_no_writable_workspace(self):
        a=namespace_argv(['python'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a')
        b=namespace_argv(['python'],'/eval/b/project','/eval/b/home','/eval/b/logs','/run/b')
        def writable(args):return [args[i+1] for i,v in enumerate(args) if v=='--bind']
        self.assertFalse(set(writable(a)) & set(writable(b)))

    def test_verifier_gets_read_only_original_tests_and_its_own_logs(self):
        a=namespace_argv(['python','-m','pytest'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a','/eval/a/tests')
        i=a.index('/eval/a/tests');self.assertEqual(a[i-1],'--ro-bind');self.assertEqual(a[i+1],'/tests')
        self.assertIn('/eval/a/logs/verifier',a)

    def test_control_is_read_only_even_for_preauthorized_commands(self):
        a=namespace_argv(['git','status'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a')
        i=a.index('/run/a')
        self.assertEqual(a[i-1], '--ro-bind')

    def test_only_verifier_can_use_private_root_overlay_or_compile_tests(self):
        for option in [{'root_overlay':True},{'writable_tests':True}]:
            with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c',**option)
        a=namespace_argv(['python'],'/p','/h','/l','/c','/t',root_overlay=True)
        self.assertEqual(a[a.index('--tmpfs')+1],'/')
        i=a.index('/etc');self.assertEqual(a[i-1],'--ro-bind')
        i=a.index('/t');self.assertEqual(a[i-1],'--ro-bind')
        b=namespace_argv(['python'],'/p','/h','/l','/c','/t',writable_tests=True)
        i=b.index('/t');self.assertEqual(b[i-1],'--bind')

    def test_headless_verifier_does_not_inherit_another_runs_server_directory(self):
        with patch('protocol.os.listdir',return_value=['etc','usr','server']):
            a=namespace_argv(['python'],'/p','/h','/l','/c','/t',root_overlay=True)
        self.assertNotIn('/server',a)
        self.assertIn('/etc',a);self.assertIn('/usr',a)

    def test_public_helpers_are_read_only_and_distinct_from_hidden_verifier(self):
        a=namespace_argv(['python'],'/p','/h','/l','/c',public_tests='/public')
        i=a.index('/public');self.assertEqual(a[i-1],'--ro-bind');self.assertEqual(a[i+1],'/tests')
        with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c','/hidden',public_tests='/public')

    def test_chroot_verifier_has_one_root_mount_and_scoped_capability(self):
        with patch('protocol.os.listdir',return_value=['etc','usr','proc','dev','app','tmp']):
            a=namespace_argv(['python'],'/p','/h','/l','/c','/tests',root_overlay=True,private_root='/private')
        self.assertEqual(a[a.index('/private')-1],'--bind');self.assertIn('CAP_SYS_CHROOT',a)
        self.assertNotIn('/p',a);self.assertNotIn('--tmpfs',a)
        self.assertEqual(a[a.index('/usr')-1],'--ro-bind')
        with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c',private_root='/private')

    def test_private_verifier_copy_preserves_executable_and_refuses_escaping_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'project';p.mkdir();f=p/'image';f.write_bytes(b'executable');f.chmod(0o755)
            prepare_verifier_root(p,Path(tmp)/'root')
            self.assertEqual((Path(tmp)/'root/app/image').read_bytes(),b'executable')
            self.assertEqual((Path(tmp)/'root/app/image').stat().st_mode & 0o111,0o111)
            self.assertTrue((Path(tmp)/'root/tmp').is_dir())
            (p/'escape').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):prepare_verifier_root(p,Path(tmp)/'bad')

    def test_isolated_actor_has_no_shared_network_or_runtime_sockets(self):
        args=namespace_argv(['bun','entry.ts'],'/p','/h','/l','/run/a',isolated_network=True)
        self.assertIn('--unshare-net',args)
        self.assertIn(['--tmpfs','/run'],[args[i:i+2] for i in range(len(args)-1)])
        self.assertNotIn('--unshare-net',namespace_argv(['pip'],'/p','/h','/l','/c'))
        with self.assertRaises(ValueError):namespace_argv(['pytest'],'/p','/h','/l','/c','/tests',isolated_network=True)


class ActorFilesystemTest(unittest.TestCase):
    def test_actor_has_no_host_root_terminal_logs_or_hidden_tests(self):
        with patch('protocol.actor_readonly_mounts',return_value=['--ro-bind','/usr','/usr']):
            args=namespace_argv(['bun','cli'],'/run/a/project','/run/a/home','/run/a/logs','/run/a/control',
                                actor_release='/release',actor_events='/run/a/events',public_tests='/run/a/public')
        self.assertIn(['--tmpfs','/'],[args[i:i+2] for i in range(len(args)-1)])
        self.assertNotIn(['--ro-bind','/','/'],[args[i:i+3] for i in range(len(args)-2)])
        self.assertNotIn('/run/a/logs',args)
        self.assertEqual(args[args.index('/run/a/home')-1],'--bind')
        self.assertEqual(args[args.index('/run/a/events')-1],'--bind')
        self.assertEqual(args[args.index('/run/a/public')-1],'--ro-bind')
        self.assertEqual(args[args.index('/run/a/public')+1],'/tests')

    def test_tex_runtime_mounts_are_read_only_and_do_not_expose_parent_state(self):
        from protocol import actor_readonly_mounts
        release = Path('/opt/hicode/releases/' + 'a' * 64)
        def resolve(path, strict=False):
            return Path('/opt/hicode/node_modules') if path == release/'node_modules' else path
        with patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'is_dir', return_value=True), \
             patch.object(Path, 'is_symlink', return_value=False), \
             patch.object(Path, 'resolve', resolve):
            args = actor_readonly_mounts(release, None)
        mounts = [args[i:i+3] for i in range(0, len(args), 3)]
        self.assertIn(['--ro-bind', '/etc/texmf', '/etc/texmf'], mounts)
        self.assertIn(['--ro-bind', '/etc/chromium.d', '/etc/chromium.d'], mounts)
        self.assertIn(['--ro-bind', '/var/lib/texmf', '/var/lib/texmf'], mounts)
        for parent in ['/etc', '/var', '/var/lib', '/eval', '/root']:
            self.assertNotIn(parent, args)
        self.assertNotIn('--bind', args)

    def test_incomplete_or_mixed_actor_views_fail_closed(self):
        for options in [{'actor_release':'/release'},{'actor_events':'/events'},
                        {'actor_release':'/release','actor_events':'/events','root_overlay':True},
                        {'actor_release':'/release','actor_events':'/events','readonly_logs':True}]:
            with self.assertRaises(ValueError):namespace_argv(['bun'],'/p','/h','/l','/c',**options)
        with self.assertRaises(ValueError):namespace_argv(['bun'],'/p','/h','/l','/c','/hidden',actor_release='/release',actor_events='/events')


class AssignmentPromptTest(unittest.TestCase):
    def test_actual_limits_have_second_precision_and_no_network_claim_when_open(self):
        from protocol import assignment_prompt
        for seconds,label in [(900,'15 分钟'),(1800,'30 分钟'),(2700,'45 分钟'),(2120,'35 分钟 20 秒'),(30,'30 秒')]:
            message=assignment_prompt('Original question',seconds,'open','/app',[])
            self.assertIn(label,message)
            self.assertNotIn('当前外网不可用',message)
            self.assertTrue(message.endswith('Original question'))
        message=assignment_prompt('Original question',1200,'isolated','/testbed',['/testbed/testing/'])
        self.assertIn('20 分钟',message);self.assertIn('当前外网不可用',message)
        self.assertIn('/testbed/testing/',message)
        self.assertIn('无需跑满时限',message)

    def test_invalid_limits_and_network_fail_before_submission(self):
        from protocol import assignment_prompt
        for seconds in [29,7201,1.5,True]:
            with self.assertRaises(ValueError):assignment_prompt('q',seconds,'isolated','/app',[])
        with self.assertRaises(ValueError):assignment_prompt('q',900,'unknown','/app',[])

    def test_swe_and_terminal_public_tests_use_their_real_entries(self):
        from dataset_runtime import dataset_runtime
        self.assertEqual(dataset_runtime({'dataset':'swe-bench-verified'}).public_test_entries({'swe':{'repo':'pytest-dev/pytest'}}),['/testbed/testing/'])
        terminal=dataset_runtime({'dataset':'terminal-bench-2.1'})
        self.assertEqual(terminal.public_test_entries({'publicTestInputs':[{'source':'environment/file.py','target':'file.py'}]}),['/tests/file.py'])
        self.assertEqual(terminal.public_test_entries({}),[])


class PublicProjectEntries(unittest.TestCase):
    def test_all_new_project_entries_can_build_an_assignment(self):
        from protocol import assignment_prompt
        from dataset_runtime import dataset_runtime
        for repo in ['astropy/astropy','scikit-learn/scikit-learn','pylint-dev/pylint','psf/requests','pallets/flask','mwaskom/seaborn','matplotlib/matplotlib']:
            entries=dataset_runtime({'dataset':'swe-bench-verified'}).public_test_entries({'swe':{'repo':repo}})
            self.assertTrue(entries)
            self.assertTrue(all(x.startswith('/testbed/') for x in entries))
            prompt=assignment_prompt('Original instruction',1800,'isolated','/testbed',entries)
            self.assertIn(entries[0],prompt)
            self.assertIn('Original instruction',prompt)
