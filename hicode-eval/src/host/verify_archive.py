"""Read every archive member before the host removes any original evidence."""
import sys
import gzip
import tarfile
from pathlib import PurePosixPath

count = total = 0
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        count += 1
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or count > 140000:
            raise ValueError('Unsafe or oversized evidence archive')
        if member.isfile():
            total += member.size
            if total > 12 * 1024 ** 3:
                raise ValueError('Evidence archive exceeds byte budget')
            with archive.extractfile(member) as stream:
                size = 0
                while chunk := stream.read(65536):
                    size += len(chunk)
                if size != member.size:
                    raise ValueError('Incomplete archive member')
        elif not (member.isdir() or member.issym() or member.islnk()):
            raise ValueError('Unsupported archive entry')
print('verified', count, 'entries', total, 'bytes')

with gzip.open(sys.argv[1], 'rb') as stream:
    while stream.read(65536):
        pass
