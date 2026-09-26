#!/usr/bin/env python3
"""Build standalone Linux sandbox tools; binary output belongs outside the checkout."""
import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent


def pack(path, entries):
    def normalize(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mtime = 0
        info.pax_headers = {}
        return info
    with path.open('wb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w') as tar:
            for file, name in entries:
                tar.add(file, arcname=name, recursive=False, filter=normalize)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--docker-context')
    parser.add_argument('--arch', choices=['arm64', 'x64', 'all'], default='all')
    args = parser.parse_args()
    manifest = json.loads((HERE / 'sources.json').read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    docker = ['docker'] + (['--context', args.docker_context] if args.docker_context else [])

    def fetch(item):
        path = args.cache / item['file']
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            part = path.with_suffix(path.suffix + '.part')
            try:
                subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--connect-timeout', '10',
                                '--max-time', '120', '--retry', '1', item['url'], '-o', str(part)], check=True, timeout=250)
                if hashlib.sha256(part.read_bytes()).hexdigest() != item['sha256']:
                    raise RuntimeError('Source checksum mismatch: ' + item['file'])
                part.replace(path)
            finally:
                part.unlink(missing_ok=True)
        return path

    with tempfile.TemporaryDirectory(prefix='hicode-runtime-build-') as tmp:
        ctx = Path(tmp)
        (ctx / 'sources').mkdir()
        (ctx / 'rootfs').mkdir()
        shutil.copyfile(HERE / 'Dockerfile', ctx / 'Dockerfile')
        for item in manifest['sources']:
            shutil.copyfile(fetch(item), ctx / 'sources' / item['file'])
        for base in manifest['rootfs']:
            arch = 'x64' if base['arch'] == 'amd64' else 'arm64'
            if args.arch not in [arch, 'all']:
                continue
            shutil.copyfile(fetch(base), ctx / 'rootfs' / (base['arch'] + '.tar.gz'))
            destination = args.output / arch
            # BuildKit supports standard proxy build args without embedding them in image history.
            proxy_args = sum((['--build-arg', name] for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] if name in os.environ), [])
            subprocess.run(docker + ['buildx', 'build', '--platform', 'linux/' + base['arch'], *proxy_args,
                                     '--output', 'type=local,dest=' + str(destination.resolve()), str(ctx)], check=True, timeout=1200)
            shutil.copyfile(HERE / 'README.md', destination / 'README.md')
            (destination / 'manifest.json').write_text(json.dumps({
                'version': manifest['version'], 'arch': arch,
                'files': {name: hashlib.sha256((destination / name).read_bytes()).hexdigest() for name in ['bin/bwrap', 'bin/socat']}
            }, indent=2) + '\n')
            archive = args.output / ('hicode-linux-runtime-' + arch + '.tar.gz')
            pack(archive, [(path, str(path.relative_to(destination))) for path in sorted(destination.rglob('*'))])
            print(archive.name, hashlib.sha256(archive.read_bytes()).hexdigest(), flush=True)
        pack(args.output / 'hicode-linux-runtime-source.tar.gz',
             [(HERE / name, name) for name in ['Dockerfile', 'build.py', 'sources.json', 'README.md']] +
             [(args.cache / item['file'], 'sources/' + item['file']) for item in manifest['sources']])


if __name__ == '__main__':
    main()
