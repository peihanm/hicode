import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from terminal_regrade import validate_snapshot, validate_completion


class ServiceRegradeTest(unittest.TestCase):
    def archive(self, members):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name)/'snapshot.tar'
        with tarfile.open(path,'w') as output:
            for member in members: output.addfile(member,io.BytesIO(b'x'*member.size) if member.isfile() else None)
        return path

    def member(self,name):
        member=tarfile.TarInfo(name);member.size=1
        return member

    def test_preserves_only_reviewed_system_paths_and_account_range(self):
        good=self.member('etc/mailman3/mailman.cfg');good.uid=38;good.gid=38
        validate_snapshot(self.archive([good]),['/etc','/var'])
        for name in ['/etc/passwd','etc/../app/answer.py','app/answer.py']:
            with self.subTest(name=name),self.assertRaises(ValueError):
                validate_snapshot(self.archive([self.member(name)]),['/etc','/var'])
        invalid=self.member('etc/passwd');invalid.uid=65536
        with self.assertRaises(ValueError):validate_snapshot(self.archive([invalid]),['/etc'])

    def test_rejects_devices_links_with_children_and_escaping_hardlinks(self):
        device=self.member('var/device');device.type=tarfile.CHRTYPE;device.size=0
        with self.assertRaises(ValueError):validate_snapshot(self.archive([device]),['/var'])
        link=self.member('etc/alias');link.type=tarfile.SYMTYPE;link.size=0;link.linkname='/app'
        with self.assertRaises(ValueError):validate_snapshot(self.archive([link,self.member('etc/alias/answer.py')]),['/etc'])
        link.type=tarfile.LNKTYPE;link.linkname='../app/answer.py'
        with self.assertRaises(ValueError):validate_snapshot(self.archive([link]),['/etc'])

    def test_rejects_duplicate_members(self):
        with self.assertRaises(ValueError):
            validate_snapshot(self.archive([self.member('etc/passwd'),self.member('etc/passwd')]),['/etc'])

    def test_ordinary_recheck_requires_persisted_completion(self):
        def record(settled_saved=True, saved=True, pending=False):
            rows=[{'type':'ready'}, {'type':'agent_event','event':{'type':'model_stream_start'}}]
            if pending:rows.append({'type':'agent_event','event':{'type':'tool_call_start','toolCallId':'unpaired'}})
            rows.extend([{'type':'agent_event','event':{'type':'turn_end','input':{'persistence_status':'saved' if saved else 'failed'}}},
                         {'type':'settled','persistenceStatus':'saved' if settled_saved else 'failed','reason':'completed','runningAgents':0,'pendingAgentMessages':0}])
            return ''.join(json.dumps({'version':1,'sequence':i,'sessionId':'fixture',**row})+'\n' for i,row in enumerate(rows,1)).encode()
        validate_completion(record())
        for data in [record(settled_saved=False),record(saved=False),record(pending=True),record()+b'{']:
            with self.assertRaisesRegex(ValueError,'settled, saved'):
                validate_completion(data)

    def test_failed_deep_answer_requires_saved_events_and_shutdown_without_claiming_completion(self):
        rows=[{'type':'ready'}, {'type':'agent_event','event':{'type':'model_stream_start'}},
              {'type':'agent_event','event':{'type':'turn_end','input':{'session_id':'fixture','status':'failed','reason':'error','persistence_status':'saved'}}}]
        data=''.join(json.dumps({'version':1,'sequence':i,'sessionId':'fixture',**row})+'\n' for i,row in enumerate(rows,1)).encode()
        shutdown={'version':1,'reason':'failed','cliExited':True,'turnSaved':True,'pendingToolCallIds':[],
                  'eventStreamComplete':True,'error':None}
        validate_completion(data, execution='failed', shutdown=shutdown)
        with self.assertRaises(ValueError):validate_completion(data)
        for field,value in [('reason','timeout'),('cliExited',False),('turnSaved',False),('pendingToolCallIds',['x']),
                            ('eventStreamComplete',False),('error','unconfirmed')]:
            with self.subTest(field=field),self.assertRaises(ValueError):
                validate_completion(data,execution='failed',shutdown={**shutdown,field:value})
        with self.assertRaises(ValueError):validate_completion(data+b'{',execution='failed',shutdown=shutdown)
        with self.assertRaises(ValueError):validate_completion(data.replace(b'saved',b'failed'),execution='failed',shutdown=shutdown)
