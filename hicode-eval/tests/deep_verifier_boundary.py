"""Native negative check: a pristine verifier cannot read the sealed Actor."""
import os
import pwd
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, '/opt/hicode-eval')
from protocol import namespace_argv
root=Path(sys.argv[1]);release=sys.argv[2];account=pwd.getpwuid(20000)
fresh=root/'boundary-project';home=root/'boundary-home'
for path in [fresh,home]:path.mkdir();os.chown(path,20000,account.pw_gid)
if not (root/'project').is_dir() or not (root/'home').is_dir():raise ValueError('Missing original Actor view')
probe="from pathlib import Path;import sys;assert not Path(sys.argv[1]).exists();assert not Path(sys.argv[2]).exists();print('PRISTINE_VERIFIER_BOUNDARY_OK')"
args=namespace_argv(['python3','-c',probe,str(root/'project'),str(root/'home')],fresh,home,root/'logs',
                    Path('/run/hicode-eval')/root.name,root/'tests',isolated_network=True,verifier_release=release)
def demote():os.setgroups([]);os.setgid(account.pw_gid);os.setuid(20000)
subprocess.run(args,preexec_fn=demote,check=True,timeout=30,env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8'})
