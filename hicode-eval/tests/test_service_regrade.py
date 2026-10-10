import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from service_regrade import validate_snapshot


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
