import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from dataset_runtime import dataset_runtime
from eval_datasets.deep_swe import validate_result, supervise
from protocol import namespace_argv, assignment_prompt

class DeepSweTest(unittest.TestCase):
    def test_original_python_environment_is_bounded_and_shared_by_actor_and_verifier(self):
        handler=dataset_runtime({'dataset':'deep-swe'})
        environment={'PYTHONPATH':'/app/src','VIRTUAL_ENV':'/opt/venv'}
        result=handler.command_environment({'deep':{'runtimeEnvironment':environment}},'/home','/run')
        self.assertEqual(result['PYTHONPATH'],'/app/src')
        self.assertEqual(result['VIRTUAL_ENV'],'/opt/venv')
        self.assertTrue(result['PATH'].startswith('/opt/venv/bin:'))
        self.assertEqual(handler.command_environment({'deep':{'runtimeEnvironment':{}}},'/home','/run'),
                         {'PYTHONDONTWRITEBYTECODE':'1'})
        for bad in [None,[],{'PATH':'/other/bin'},{'PYTHONPATH':'/tests'},{'VIRTUAL_ENV':'/other/home'}, {'PYTHONPATH':{}}]:
            with self.assertRaises(ValueError):handler.command_environment({'deep':{'runtimeEnvironment':bad}},'/home','/run')

    def setUp(self):
        self.original={'p2p_node_ids':['stable'],'f2p_node_ids':['new','new']}
        self.reward={'reward':0,'p2p_total':1,'p2p_passed':1,'f2p_total':1,'f2p_passed':0}
        self.ctrf={'results':{'summary':{'tests':2,'passed':1,'failed':1,'skipped':0,'pending':0,'other':0},'tests':[{'name':'[p2p] stable','status':'passed'},{'name':'[f2p] new','status':'failed'}]}}

    def test_original_whitelist_and_reward_must_agree(self):
        validate_result(self.reward,self.ctrf,self.original,'failed')
        bad=copy.deepcopy(self.ctrf);bad['results']['tests'][1]['status']='passed'
        with self.assertRaises(ValueError):validate_result(self.reward,bad,self.original,'failed')
        bad=copy.deepcopy(self.ctrf);bad['results']['tests'].pop()
        with self.assertRaises(ValueError):validate_result(self.reward,bad,self.original,'failed')
        with self.assertRaises(ValueError):validate_result({**self.reward,'reward':1},self.ctrf,self.original,'passed')
        self.reward.update(reward=1,f2p_passed=1);self.ctrf['results']['tests'][1]['status']='passed';self.ctrf['results']['summary'].update(passed=2,failed=0)
        validate_result(self.reward,self.ctrf,self.original,'passed')

    def test_patch_apply_failure_is_failed_not_infrastructure_or_passed(self):
        reward={**self.reward,'p2p_passed':0,'apply_failed':1}
        validate_result(reward,None,self.original,'failed')
        with self.assertRaises(ValueError):validate_result(reward,None,self.original,'passed')

    def test_verifier_network_is_isolated_and_uses_a_distinct_workspace(self):
        args=namespace_argv(['--ro-bind','/r/artifacts','/logs/artifacts','bash','/tests/test.sh'],
                            '/r/fresh','/r/fresh-home','/r/logs','/control','/r/tests',isolated_network=True)
        self.assertIn('--unshare-net',args)
        self.assertNotIn('/r/project',args)
        self.assertEqual(args[-2:],['bash','/tests/test.sh'])
        self.assertIn('180 分钟',assignment_prompt('question',10800,'isolated','/app',[]))

    def test_pristine_verifier_cannot_see_the_actor_home_or_uncommitted_files(self):
        with patch('protocol.actor_readonly_mounts',return_value=['--ro-bind','/usr','/usr']):
            args=namespace_argv(['bash','/tests/test.sh'],'/fresh-project','/fresh-home','/logs','/control','/tests',
                                isolated_network=True,verifier_release='/release')
        self.assertIn(['--tmpfs','/'],[args[i:i+2] for i in range(len(args)-1)])
        self.assertNotIn(['--ro-bind','/','/'],[args[i:i+3] for i in range(len(args)-2)])
        self.assertNotIn('/old-project',args)
        self.assertNotIn('/old-home',args)
        with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c',verifier_release='/release')

    def test_timeout_and_cancellation_stop_verifier_process_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls=iter([False,True]);cancel_after_start=lambda:next(calls,True)
            for cancelled in [lambda:False,cancel_after_start]:
                with self.assertRaises((TimeoutError,RuntimeError)):
                    supervise(['python3','-c','import time;time.sleep(60)'],timeout=.05,
                              output=Path(tmp)/'log',env=os.environ,demote=lambda:None,cancelled=cancelled)

    def test_recovery_checks_original_report_and_patch_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'tests').mkdir();(root/'logs/verifier').mkdir(parents=True);(root/'artifacts').mkdir()
            (root/'tests/config.json').write_text(json.dumps(self.original))
            (root/'logs/verifier/reward.json').write_text(json.dumps(self.reward))
            (root/'logs/verifier/ctrf.json').write_text(json.dumps(self.ctrf))
            (root/'artifacts/model.patch').write_bytes(b'committed diff')
            (root/'patch-manifest.json').write_text(json.dumps({'baseCommit':'a'*40,'bytes':14,'sha256':hashlib.sha256(b'committed diff').hexdigest()}))
            handler=dataset_runtime({'dataset':'deep-swe'});job={'deep':{'baseCommit':'a'*40}}
            proof=handler.recovery_evidence(root,job,'failed',lambda p,limit:p.read_bytes())
            self.assertIn('artifacts/model.patch',proof)
            (root/'artifacts/model.patch').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'patch changed'):handler.recovery_evidence(root,job,'failed',lambda p,limit:p.read_bytes())

if __name__=='__main__':unittest.main()
