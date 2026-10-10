import unittest
from unittest.mock import patch
from terminal import capture, settle, submit_prompt


class TerminalTest(unittest.TestCase):
    def test_prompt_enter_is_separated_from_paste_and_sent_only_once(self):
        clock = [0.0]
        calls = []
        def tmux(*args, **kwargs):
            calls.append((clock[0], args))
            if args[0] == 'capture-pane':
                if not any(call[1][0] == 'paste-buffer' for call in calls):
                    return '❯ Ask HiCode to build, inspect, or fix something'
                if clock[0] < 1.5:
                    return 'Welcome finished painting\n❯ Ask HiCode to build, inspect, or fix something'
                if clock[0] < 2.5:
                    return '\x1b[1m❯ \x1b[0m[Pasted text #1 +2 lines]\n' + str(clock[0])
                return '\x1b[1m❯ \x1b[0m[Pasted text #1 +25 lines]'
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertTrue(submit_prompt(tmux, '/run/test/prompt.txt', lambda: False))
        controls = [(at,args) for at,args in calls if args[0] != 'capture-pane']
        self.assertEqual([args[0] for _,args in controls], ['load-buffer','paste-buffer','send-keys'])
        self.assertGreaterEqual(controls[-1][0], 3.0)
        self.assertEqual(controls[-1][1][-1], 'Enter')

    def test_unconsumed_paste_times_out_without_sending_enter(self):
        clock = [0.0]
        calls = []
        def tmux(*args, **kwargs):
            calls.append(args)
            return 'Welcome ' + str(clock[0]) + '\n❯ Ask HiCode to build, inspect, or fix something'
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            with self.assertRaisesRegex(RuntimeError, 'Prompt paste did not settle'):
                submit_prompt(tmux, '/run/test/prompt.txt', lambda: False)
        self.assertFalse(any(args[0] == 'send-keys' for args in calls))
        self.assertLess(clock[0], 15.2)

    def test_prompt_waits_for_input_mount_and_can_be_cancelled(self):
        clock = [0.0]
        calls = []
        def tmux(*args, **kwargs):
            calls.append(args)
            return 'Reading session…'
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertFalse(submit_prompt(tmux, '/run/test/prompt.txt', lambda: clock[0] >= .3))
        self.assertTrue(all(args[0] == 'capture-pane' for args in calls))

    def test_completion_waits_for_delayed_paint_and_keeps_last_frame(self):
        clock = [0.0]
        packets = []
        def tmux(*args, **kwargs):
            self.assertEqual(args[0], 'capture-pane')
            return 'Generating response' if clock[0] < .7 else 'Complete final answer\nWorked for 5m'
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertTrue(settle(tmux, lambda kind, **p: packets.append(p['screen']), lambda: False))
        self.assertGreaterEqual(clock[0], 1.7)
        self.assertEqual(packets, ['Generating response', 'Complete final answer\nWorked for 5m'])

    def test_animation_is_bounded_and_cancellation_does_not_wait(self):
        clock = [0.0]
        def tmux(*args, **kwargs): return str(clock[0])
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertFalse(settle(tmux, lambda *args, **kwargs: None, lambda: False))
            self.assertLess(clock[0], 5.2)
            before = clock[0]
            self.assertFalse(settle(tmux, lambda *args, **kwargs: None, lambda: True))
            self.assertEqual(clock[0], before)

    def test_final_capture_is_not_throttled_or_skipped_if_screen_unchanged(self):
        packets = []
        for _ in range(2): capture(lambda *a, **kw: 'final', lambda kind, **p: packets.append(p))
        self.assertEqual(packets, [{'screen': 'final'}, {'screen': 'final'}])
