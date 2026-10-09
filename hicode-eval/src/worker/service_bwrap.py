#!/opt/python313/bin/python3.13
"""Scoped Bubblewrap entry for a root-mapped service user namespace."""
import os
from pathlib import Path
import sys

BWRAP = '/usr/bin/bwrap'


def bwrap_argv(args):
    if args in (['--version'], ['--help']):
        return [BWRAP, *args]
    drops=[i for i in range(len(args)-1) if args[i:i+2]==['--cap-drop','ALL']]
    if (len(drops)!=1 or '--cap-add' in args
            or not ('--unshare-user' in args or '--unshare-all' in args)):
        raise ValueError('Expected one capability-dropped HiCode sandbox')
    index=drops[0]+2
    return [BWRAP,*args[:index],'--cap-add','CAP_SETFCAP',*args[index:]]


def main():
    mapping=Path('/proc/self/uid_map').read_text().strip().split()
    if os.geteuid()!=0 or mapping!=['0','20000','65536']:
        raise ValueError('Service Bubblewrap must run as root in the owned user namespace')
    os.execv(BWRAP,bwrap_argv(sys.argv[1:]))


if __name__=='__main__':main()
