# HiCode Linux sandbox helpers

`linux-runtime-v1` provides standalone ARM64 and x64 executables:

- bubblewrap 0.13.0 (LGPL-2.1-or-later): filesystem/process/network isolation.
- socat 1.8.1.3 (GPL-2.0-only with OpenSSL exception): TCP/Unix-socket/SOCKS relay. This build omits OpenSSL, readline and libwrap; it forwards TLS bytes without terminating TLS.
- bubblewrap statically links libcap 2.76; both tools statically link Alpine's musl libc. Licenses are included under `licenses/`.

These executables are not setuid and do not grant root privileges. They still require a Linux kernel and host policy permitting unprivileged user namespaces. Installing them does not change AppArmor, seccomp or system proxy policy. A Docker test container needs explicitly configured nested-sandbox permissions.

## Build

Requires Docker Buildx, Python 3.9+ and curl. An ARM host needs x64 emulation to build both architectures (and conversely for x64 hosts). Output/cache directories must be outside the Git checkout:

```sh
python3 tooling/linux-runtime/build.py --docker-context colima-hicode \
  --cache /tmp/hicode-runtime-sources --output /tmp/hicode-runtime-output
```

Use `--arch arm64` or `--arch x64` for one architecture. Omit `--docker-context` to use the current Docker context. Standard HTTP(S) proxy environment variables are optional. Sources and Alpine rootfs are pinned and verified using `sources.json`; no binary is checked into Git. The build installs compiler packages in an isolated Alpine rootfs, not on the host, and rejects an ELF interpreter dependency in the resulting helpers.

## Distribution

Publish `hicode-linux-runtime-{arm64,x64}.tar.gz` and `hicode-linux-runtime-source.tar.gz` together under the `linux-runtime-v1` GitHub Release. The source archive includes the upstream program/library sources, socat compatibility patches, and build recipe; extract source files into the build script's cache to reuse them. The Alpine rootfs and toolchain packages are downloaded by the recipe. The musl archive is the upstream source reference; Alpine may apply distribution patches to its toolchain/libc packages.

Release URL: https://github.com/peihanm/hicode/releases/tag/linux-runtime-v1

The installer pins the archive SHA-256 values, verifies before extraction, and installs into its own user-owned runtime directory. The generated HiCode launcher sets `HICODE_LINUX_RUNTIME_DIR`; it does not add bwrap/socat to the user's global PATH. A configured but unavailable helper directory fails explicitly instead of falling back to an arbitrary executable from PATH. SDK/source users without this environment variable may use installed system tools.

Maintain these helpers as security-sensitive dependencies: rebuild and publish a new runtime version for upstream security updates, update checksums, and run the real filesystem, network and scoped-search tests before distribution. Do not replace assets under an existing version.
