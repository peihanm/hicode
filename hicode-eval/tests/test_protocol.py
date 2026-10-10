import json
import unittest
from protocol import Events

class ProtocolTest(unittest.TestCase):
    def test_ready_does_not_acknowledge_prompt_submission(self):
        stream=Events()
        stream.accept(self.record(1,type='ready'))
        self.assertFalse(stream.started)
        stream.accept(self.record(2,type='state',busy=False,waitingForApproval=False))
        self.assertFalse(stream.started)
        stream.accept(self.record(3,type='agent_event',event={'type':'iteration','current':1}))
        self.assertFalse(stream.started)
        stream.accept(self.record(4,type='agent_event',event={'type':'model_stream_start'}))
        self.assertTrue(stream.started)

    def record(self, seq, **event):return (json.dumps({'version':1,'sequence':seq,'sessionId':'a',**event})+'\n').encode()
    def test_shutdown_seals_saved_cancelled_turn_without_ignoring_missing_results(self):
        # SymPy 16597 exports cancelled/shutdown, followed by a sealed shutdown.
        for persistence in ('saved', 'failed'):
            stream=Events()
            stream.accept(self.record(1,type='agent_event',event={'type':'tool_call_start','toolCallId':'bash'}))
            stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{
                'session_id':'a','status':'cancelled','reason':'shutdown','persistence_status':persistence}}))
            stream.accept(self.record(3,type='settled',reason='shutdown',runningAgents=0,pendingAgentMessages=0,sealed=True))
            self.assertFalse(stream.complete())
            stream.accept(self.record(4,type='agent_event',event={'type':'tool_call_end','toolCallId':'bash'}))
            self.assertEqual(stream.complete(),persistence=='saved')
            self.assertFalse(stream.failed_turn())

    def test_unknown_stop_reason_still_fails_closed(self):
        with self.assertRaisesRegex(ValueError,'Unknown stop reason'):
            Events().accept(self.record(1,type='settled',reason='made-up',runningAgents=0,pendingAgentMessages=0,sealed=True))
    def test_partial_event_and_child_guard(self):
        stream=Events();data=self.record(1,type='ready',sessionId='a')
        stream.accept(data[:7]);self.assertFalse(stream.ready)
        stream.accept(data[7:]);self.assertTrue(stream.ready)
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(3,type='settled',reason='completed',runningAgents=1,pendingAgentMessages=0,sealed=True))
        self.assertFalse(stream.complete())
        stream.accept(self.record(4,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=True))
        self.assertTrue(stream.complete())
        stream.accept(self.record(5,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=1,sealed=False))
        self.assertFalse(stream.complete())
    def test_missing_sequence_and_failed_persistence(self):
        stream=Events()
        with self.assertRaises(ValueError):stream.accept(self.record(2,type='ready'))
        stream=Events()
        stream.accept(self.record(1,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=True))
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'failed'}}))
        self.assertFalse(stream.complete())
    def test_invalid_counters_and_mixed_sessions(self):
        stream=Events()
        with self.assertRaises(ValueError):stream.accept(self.record(1,type='settled',reason='completed',runningAgents=False,pendingAgentMessages=0,sealed=True))
        stream=Events();stream.accept(self.record(1,type='ready'))
        with self.assertRaises(ValueError):stream.accept(self.record(2,type='ready',sessionId='different'))

    def test_saved_turn_requires_execution_seal(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(2,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=False))
        self.assertFalse(stream.complete())

    def test_partial_record_after_seal_cannot_expose_private_verifier(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(2,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=True))
        self.assertTrue(stream.complete())
        next_record=self.record(3,type='agent_event',event={'type':'tool_call_start','toolCallId':'late'})
        stream.accept(next_record[:15]);self.assertFalse(stream.complete())
        stream.accept(next_record[15:]);self.assertFalse(stream.complete())

    def test_missing_tool_result_cannot_claim_saved_completion(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'tool_call_start','toolCallId':'a'}))
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(3,type='settled',reason='interrupted',runningAgents=0,pendingAgentMessages=0,sealed=True))
        self.assertFalse(stream.complete())
        self.assertEqual(stream.pending_tools, {'a'})
        stream.accept(self.record(4,type='agent_event',event={'type':'tool_call_end','toolCallId':'a'}))
        self.assertTrue(stream.complete())

    def test_failure_without_settled_requests_stop_but_never_claims_completion(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'model_stream_start'}))
        stream.accept(self.record(2,type='state',busy=True,waitingForApproval=False))
        stream.accept(self.record(3,type='agent_event',event={'type':'turn_end','input':{
            'session_id':'a','status':'failed','reason':'error','persistence_status':'saved'}}))
        self.assertFalse(stream.failed_turn())
        stream.accept(self.record(4,type='state',busy=False,waitingForApproval=False))
        self.assertTrue(stream.failed_turn())
        self.assertFalse(stream.complete())
        stream.accept(self.record(5,type='settled',reason='error',status='failed',persistenceStatus='saved',
                                  runningAgents=0,pendingAgentMessages=0,sealed=True))
        self.assertTrue(stream.failed_turn())

    def test_failed_persistence_and_pending_tools_still_need_owner_shutdown(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'model_stream_start'}))
        stream.accept(self.record(2,type='agent_event',event={'type':'tool_call_start','toolCallId':'a'}))
        stream.accept(self.record(3,type='agent_event',event={'type':'turn_end','input':{
            'session_id':'a','status':'failed','reason':'error','persistence_status':'failed'}}))
        self.assertTrue(stream.failed_turn())
        self.assertFalse(stream.complete())
        self.assertEqual(stream.pending_tools, {'a'})

    def test_approval_new_turn_and_partial_stream_are_not_failed_terminal(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'model_stream_start'}))
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{
            'session_id':'a','status':'failed','reason':'error','persistence_status':'saved'}}))
        stream.accept(self.record(3,type='state',busy=False,waitingForApproval=True))
        self.assertFalse(stream.failed_turn())
        stream.accept(self.record(4,type='state',busy=False,waitingForApproval=False))
        partial=self.record(5,type='agent_event',event={'type':'model_stream_start'})
        stream.accept(partial[:10])
        self.assertFalse(stream.failed_turn())
        stream.accept(partial[10:])
        self.assertFalse(stream.failed_turn())

    def test_success_cancel_and_unsaved_unknown_status_do_not_become_model_failure(self):
        for status,reason,persistence in [('completed','completed','saved'),('cancelled','interrupted','saved'),
                                           ('failed','error','unknown')]:
            stream=Events()
            stream.accept(self.record(1,type='agent_event',event={'type':'model_stream_start'}))
            stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{
                'session_id':'a','status':status,'reason':reason,'persistence_status':persistence}}))
            self.assertFalse(stream.failed_turn())

    def test_another_sessions_failed_turn_does_not_end_root_attempt(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'model_stream_start'}))
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{
            'session_id':'child','status':'failed','reason':'error','persistence_status':'saved'}}))
        self.assertFalse(stream.failed_turn())
