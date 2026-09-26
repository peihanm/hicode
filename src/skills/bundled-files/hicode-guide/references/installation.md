# Installation and updates

## Supported environment

The interactive CLI supports macOS and experimental glibc Linux on ARM64/x64. Linux requires bubblewrap, socat and permission to create unprivileged user/PID/mount/network namespaces. The installer provides versioned, checksum-verified bubblewrap/socat binaries in its own user installation directory; no apt/sudo is required. It does not change system namespace or security policy. Musl Linux, Windows and WSL are not validated. It runs on the user's machine and requires a model provider API key. Model usage is billed by the provider.

## Quick installation

Run in the user's terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/peihanm/hicode/main/install.sh -o hicode-install.sh && bash hicode-install.sh
```

Run the installer as a regular user, without sudo. It detects the platform and installs Bun, ripgrep, Linux sandbox helpers and HiCode in the user directory. Linux helpers live under ~/.local/share/hicode/runtime/linux-runtime-v1-<arch>; the launcher sets HICODE_LINUX_RUNTIME_DIR to that directory, without changing the global PATH for bwrap/socat. Cached helpers are checked against pinned file hashes on installation/update. A real namespace probe must succeed before switching the HiCode launcher; if blocked, ask the administrator to review host policy rather than disabling isolation. Open a new terminal, enter the project to work on and start HiCode:

```sh
cd /path/to/project
hicode
```

The first launch opens provider configuration when no usable primary model is configured. Select a provider, enter its key and endpoint, then choose a model. See [Models](models.md).

## Update an installer-managed copy

Exit HiCode and rerun the quick-install command. The installer prepares and checks the new copy before switching the launcher, then removes recognized older managed versions. User configuration, sessions and memory live separately and are preserved.

Managed copies are under `~/.local/share/hicode/releases/`; the launcher is `~/.local/share/hicode/bin/hicode`. These are installation files, not the `~/.hicode` user data directory. Do not manually delete user data to update the program.

If the launcher points to a developer-owned checkout, update that checkout through Git instead. The remote installer does not overwrite an existing source-checkout launcher.

## Develop HiCode from source

With Git installed:

```sh
git clone https://github.com/peihanm/hicode.git
cd hicode
bash install.sh
```

Keep this checkout: the launcher will reference it. Open a new terminal, return to the checkout, and run:

```sh
bun install --frozen-lockfile
hicode
```

Use the installed `hicode` launcher for source development too: it points to the checkout and selects its Linux helpers. Direct `bun run start` or SDK hosts need HICODE_LINUX_RUNTIME_DIR or system bwrap/socat. Restart HiCode after editing source. Running `hicode` from other project directories uses this same checkout. To update it, inspect local changes and the current branch before fetching/integrating upstream; never discard local changes as part of an update.

Development checks: `bun test`, `bun run check`, and `bun run verify`. The full verify command also checks SDK packaging and requires Node.js 22.12 or newer.

## Command not found or wrong copy

1. Open a new terminal after installation so the shell loads its updated PATH.
2. Run `command -v hicode` and `type -a hicode` to see which launcher is selected.
3. Compare it with `~/.local/share/hicode/bin/hicode`. Inspect the launcher rather than assuming an older globally installed command is current.
4. If installation failed, use its actual error to distinguish a download failure, unsupported environment, conflicting launcher or incomplete dependency installation. Do not repeatedly reinstall without finding the cause.

For proxy/DNS failures, verify the user's existing network setup. Do not disable TLS verification or silently modify system proxy settings.
