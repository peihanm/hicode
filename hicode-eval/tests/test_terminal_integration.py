import os
import json
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from terminal import capture, settle, submit_prompt


@unittest.skipUnless(os.environ.get('HICODE_EVAL_TMUX_INTEGRATION') == '1' and shutil.which('tmux'),
                     'Requires opt-in local tmux integration')
class TerminalIntegrationTest(unittest.TestCase):
    def test_slow_pty_reader_receives_enter_separately_from_paste(self):
        # Simulate a busy TUI that cannot consume stdin until after the old .5s delay.
        # Real tmux/PTY buffering must merge the old sequence, while the handshake
        # waits for the reader's painted input before sending its single Enter.
        for handshake in [False, True]:
            with self.subTest(handshake=handshake), tempfile.TemporaryDirectory(prefix='eval-terminal-') as directory:
                root = Path(directory)
                socket = str(root / 'tmux.sock')
                ready, receipt, submitted = root/'ready', root/'receipt.json', root/'submitted'
                prompt = root/'prompt.txt'
                prompt.write_text('Implement the requested feature.\nUse the local repository.\nCommit your changes.')
                script = root/'reader.py'
                script.write_text(
                    'import json,os,sys,time,tty\nfrom pathlib import Path\n'
                    'tty.setraw(sys.stdin.fileno())\n'
                    'print("❯ Ask HiCode to build, inspect, or fix something",flush=True)\n'
                    f'Path({str(ready)!r}).touch()\n'
                    'time.sleep(1.5)\n'
                    'paste=os.read(0,1048576)\n'
                    f'Path({str(receipt)!r}).write_text(json.dumps({{"paste":paste.decode()}}))\n'
                    'print("\\x1b[2J\\x1b[H❯ [Pasted text #1 +2 lines]",flush=True)\n'
                    'key=os.read(0,1048576)\n'
                    f'Path({str(submitted)!r}).write_text(json.dumps({{"key":key.decode()}}))\n'
                    'time.sleep(15)\n')
                def tmux(*args, timeout=2):
                    return subprocess.check_output(['tmux','-S',socket,*args],text=True,timeout=timeout)
                try:
                    tmux('-f','/dev/null','new-session','-d','-s','hicode','-x','140','-y','40',
                         'exec '+shlex.join([sys.executable,str(script)]))
                    deadline = time.monotonic()+5
                    while not ready.exists():
                        if time.monotonic()>=deadline:self.fail('PTY reader did not start')
                        time.sleep(.01)
                    if handshake:
                        self.assertTrue(submit_prompt(tmux,prompt,lambda:False))
                    else:
                        tmux('load-buffer',str(prompt));tmux('paste-buffer','-p','-t','hicode:0.0')
                        time.sleep(.5);tmux('send-keys','-t','hicode:0.0','Enter')
                    deadline = time.monotonic()+3
                    while not receipt.exists() or (handshake and not submitted.exists()):
                        if time.monotonic()>=deadline:self.fail('PTY receipt missing')
                        time.sleep(.01)
                    paste = json.loads(receipt.read_text())['paste']
                    # tmux translates pasted LF into CR unless bracketed paste mode is enabled.
                    normalized = paste.replace('\r', '\n')
                    if handshake:
                        self.assertEqual(normalized,prompt.read_text())
                        self.assertEqual(json.loads(submitted.read_text())['key'],'\r')
                    else:
                        self.assertEqual(normalized,prompt.read_text()+'\n')
                        self.assertFalse(submitted.exists())
                finally:
                    subprocess.run(['tmux','-S',socket,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    def test_completion_before_final_pty_output(self):
        with tempfile.TemporaryDirectory(prefix='eval-terminal-') as directory:
            root = Path(directory)
            socket = str(root / 'tmux.sock')
            script = root / 'paint.py'
            ready = root / 'ready'
            script.write_text('import time\nfrom pathlib import Path\n'
                              'print("Generating response...",flush=True)\n'
                              f'Path({str(ready)!r}).touch()\n'
                              'time.sleep(.7)\n'
                              'print("\\x1b[2J\\x1b[HComplete final answer\\nWorked for 1s",flush=True)\n'
                              'time.sleep(15)\n')
            def tmux(*args, timeout=2):
                return subprocess.check_output(['tmux', '-S', socket, *args], text=True, timeout=timeout)
            try:
                tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'hicode', '-x', '140', '-y', '40',
                     'exec ' + shlex.join([sys.executable, str(script)]))
                deadline = time.monotonic() + 5
                while not ready.exists():
                    if time.monotonic() >= deadline: self.fail('PTY did not start')
                    time.sleep(.01)
                packets = []
                self.assertTrue(settle(tmux, lambda kind, **p: packets.append(p['screen']), lambda: False))
                self.assertIn('Complete final answer', packets[-1])
                self.assertIn('Worked for 1s', packets[-1])
                # Clear-screen may move the old frame into tmux scrollback; preserve that history.
                self.assertEqual([line for line in packets[-1].splitlines() if line][-2:],
                                 ['Complete final answer', 'Worked for 1s'])
                self.assertEqual(capture(tmux, lambda *a, **kw: None), packets[-1])
            finally:
                subprocess.run(['tmux', '-S', socket, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
