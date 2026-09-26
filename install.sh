#!/bin/bash
set -euo pipefail

fail() { printf 'HiCode install: %s\n' "$*" >&2; exit 1; }
trap 'printf "HiCode installation failed. Fix the error above and rerun the installer.\n" >&2' ERR
[[ $EUID -ne 0 ]] || fail "Run this script as your normal user, without sudo."

target_os=$(uname -s)
case "$target_os" in
    Darwin) ;;
    Linux)
        getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail "Linux installation currently requires glibc (for example Debian or Ubuntu)."
        ;;
    *) fail "Only macOS and glibc Linux are supported." ;;
esac
login_shell=${SHELL:-/bin/bash}
case "${login_shell##*/}" in
    zsh) startup_files=("${ZDOTDIR:-$HOME}/.zshrc") ;;
    bash)
        if [[ -e "$HOME/.bash_profile" ]]; then login_file="$HOME/.bash_profile"
        elif [[ -e "$HOME/.bash_login" ]]; then login_file="$HOME/.bash_login"
        elif [[ -e "$HOME/.profile" ]]; then login_file="$HOME/.profile"
        else login_file="$HOME/.bash_profile"; fi
        startup_files=("$login_file" "$HOME/.bashrc") ;;
    *) fail "Automatic setup supports zsh and bash. Switch to one of these login shells first." ;;
esac

# Install only the required binaries, without a package-manager bootstrap.
install_root="$HOME/.local/share/hicode"
export PATH="$install_root/bin:${BUN_INSTALL:-$HOME/.bun}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
staging=$(mktemp -d "${TMPDIR:-/tmp}/hicode-install.XXXXXX")
pending_release=""
launcher_temp=""
install_locked=false
cleanup() {
    [[ -z "$launcher_temp" ]] || rm -f "$launcher_temp"
    [[ -z "$pending_release" ]] || rm -rf "$pending_release"
    rm -rf "$staging"
    if [[ "$install_locked" == true ]]; then rmdir "$install_root/.install.lock"; fi
}
trap cleanup EXIT
[[ ! -L "$install_root" && ! -L "$install_root/bin" && ! -L "$install_root/releases" ]] || fail "Installation directories must not be symlinks."
mkdir -p "$install_root"
mkdir "$install_root/.install.lock" 2>/dev/null || fail "Another installer may be running. If none is running, remove $install_root/.install.lock and retry."
install_locked=true
trap 'exit 130' INT
trap 'exit 143' TERM

download() {
    curl --fail --location --show-error --connect-timeout 10 --max-time 180 \
        --retry 2 --retry-max-time 240 --speed-limit 1024 --speed-time 30 \
        "$1" -o "$2"
}
install_binary() {
    local name=$1 url=$2 checksum=$3 entry=$4
    local archive="$staging/$name.tgz" unpack="$staging/$name"
    printf 'Downloading %s directly from the npm registry...\n' "$name"
    download "$url" "$archive"
    [[ "$(digest 512 "$archive")" == "$checksum" ]] || fail "Invalid $name archive checksum."
    mkdir -p "$unpack" "$install_root/bin"
    tar -xzf "$archive" -C "$unpack" "$entry"
    [[ -f "$unpack/$entry" && ! -L "$unpack/$entry" ]] || fail "Invalid $name archive."
    chmod 755 "$unpack/$entry"
    mv -f "$unpack/$entry" "$install_root/bin/$name"
}
digest() {
    local bits=$1 path=$2 output
    if command -v "sha${bits}sum" >/dev/null; then output=$("sha${bits}sum" "$path")
    else output=$(shasum -a "$bits" "$path"); fi
    printf '%s' "${output%% *}"
}
bun_supported() {
    local version major minor
    command -v bun >/dev/null || return 1
    version=$(bun --version) || return 1
    [[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]] || return 1
    major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}
    (( major > 1 || (major == 1 && minor >= 3) ))
}
# Versions and SHA-512 values come from the publishers' npm package metadata.
case "$target_os:$(uname -m)" in
    Darwin:arm64)
        bun_package=bun-darwin-aarch64
        bun_checksum=3a68f6d12ba21c13948d4048caab643634942233ad10e27099b8b1fd9c851f805a43a3994da6915884784e31d5cf4c9a7478258ba94b4e2021d6e6ab9ef0f8f4
        rg_package=ripgrep-darwin-arm64
        rg_checksum=af792d1d2bdb172710345eac97bb0d0cfa1ca6c23b27e984ce1d48699164634b299b793667db7c84f01e38aefea7497aa7afecc24402d785d65f4d65a30fbde1 ;;
    Darwin:x86_64)
        bun_package=bun-darwin-x64-baseline
        bun_checksum=3927ec4d9b2d73cf7c1c7125854e0d71c68118e4920e7e557da8625539e2759f41ffec1bed64f27d925a05e25c7e3c09f47d96f6e4e1d931ad97751f717815f6
        rg_package=ripgrep-darwin-x64
        rg_checksum=db96f88166cbd77f1d1ae414db8e1e6c228a734ab4e542c1328152cfda001141cd7aa2bf94e2558834bb0d1bdb0dacf303348475a9f7f7566792cfd1e6691a4d ;;
    Linux:aarch64|Linux:arm64)
        runtime_arch=arm64
        runtime_asset_id=589592093
        runtime_checksum=293dc6fbde37341f97c3774345e599362225ff859cde6a4c7fc059cfdb02d889
        bwrap_checksum=50e4602fa6c5b45769e5f2db1b11b63ceadf83963cbdc166c50ab1f490f43e28
        socat_checksum=aa59fca1cb87fd05dfc240b8823ea42bbd6d95a2bf7b98012c2157df1d953f4d
        bun_package=bun-linux-aarch64
        bun_checksum=5f94ac3d91ecfa260ef11fde7c8711b5cee04f64360e03df9620b1124c7871706e9b0930d1cfc4b0730dc07dc4806a420da67b21854f869086ff104e40713067
        rg_package=ripgrep-linux-arm64
        rg_checksum=950ff9cd31bef94d04dc8855812e043d34e7fd4e2892771a44c33918e15f398672c12e27b83df51a19076cd6250e4e42b830baf3e858274fde41ec822890c0fa ;;
    Linux:x86_64)
        runtime_arch=x64
        runtime_asset_id=589592096
        runtime_checksum=b0ff3ca80d900f0ec0d84df3a51b49cd27b1aa60de79d775ab10ce3156448b85
        bwrap_checksum=daa199a99e5bf7930b2cc2f9fd051bcd57ef262b6ca8b55cf40f0b5d4673ee2f
        socat_checksum=c5e9f7bb0a092a17869a8db21e5c030b07ecdbe9626801fde7ac5f4f2756ec21
        bun_package=bun-linux-x64-baseline
        bun_checksum=abff0474e0b4c9413c14f7a8395abcfcfc3923dfed25a62651f3bfb83500444c7c2149ce247d5127903706316aadef29bc9a22640f40a2f3c9ab916734d8d2c4
        rg_package=ripgrep-linux-x64
        rg_checksum=990ddb56b5299c3dafb3b413d2f5fdd0bb7472752ae3aeee16d124b4876c249996dbde91a1250b446a968331b500ac720693430fa97864ee2a29fe928320b6dd ;;
    *) fail "Unsupported CPU architecture; use ARM64 or x86_64." ;;
esac
if ! bun_supported; then
    install_binary bun "https://registry.npmjs.org/@oven/$bun_package/-/$bun_package-1.3.14.tgz" "$bun_checksum" package/bin/bun
    hash -r
fi
if ! command -v rg >/dev/null || ! rg --version >/dev/null 2>&1; then
    install_binary rg "https://registry.npmjs.org/@vscode/$rg_package/-/$rg_package-1.18.0.tgz" "$rg_checksum" package/bin/rg
    hash -r
fi
bun_supported || fail "Bun 1.3 or newer is required."
rg --version >/dev/null

runtime_dir=""
if [[ "$target_os" == Linux ]]; then
    runtime_version=linux-runtime-v1
    runtime_dir="$install_root/runtime/$runtime_version-$runtime_arch"
    [[ ! -L "$install_root/runtime" && ! -L "$runtime_dir" ]] || fail "Runtime installation directories must not be symlinks."
    if [[ ! -e "$runtime_dir" ]]; then
        printf 'Downloading Linux sandbox helpers...\n'
        # The public asset API redirects directly to GitHub's asset CDN. It needs
        # no token and also works on networks where github.com itself is blocked.
        if ! curl --fail --location --show-error --connect-timeout 5 --max-time 60 \
            --speed-limit 1024 --speed-time 15 --header 'Accept: application/octet-stream' \
            "https://api.github.com/repos/peihanm/hicode/releases/assets/$runtime_asset_id" -o "$staging/runtime.tgz"; then
            printf 'Trying the GitHub release download URL...\n'
            download "https://github.com/peihanm/hicode/releases/download/$runtime_version/hicode-linux-runtime-$runtime_arch.tar.gz" "$staging/runtime.tgz"
        fi
        [[ "$(digest 256 "$staging/runtime.tgz")" == "$runtime_checksum" ]] || fail "Invalid Linux runtime archive checksum."
        mkdir "$staging/runtime"
        tar -xzf "$staging/runtime.tgz" -C "$staging/runtime"
        for helper in bwrap socat; do
            [[ -f "$staging/runtime/bin/$helper" && ! -L "$staging/runtime/bin/$helper" ]] || fail "Invalid runtime helper: $helper"
        done
        [[ "$(digest 256 "$staging/runtime/bin/bwrap")" == "$bwrap_checksum" &&
           "$(digest 256 "$staging/runtime/bin/socat")" == "$socat_checksum" ]] || fail "Invalid runtime helper checksum."
        mkdir -p "$install_root/runtime"
        mv "$staging/runtime" "$runtime_dir"
    fi
    [[ -d "$runtime_dir" && ! -L "$runtime_dir/bin" &&
       -f "$runtime_dir/bin/bwrap" && ! -L "$runtime_dir/bin/bwrap" &&
       -f "$runtime_dir/bin/socat" && ! -L "$runtime_dir/bin/socat" ]] || fail "Invalid installed Linux runtime: $runtime_dir"
    [[ "$(digest 256 "$runtime_dir/bin/bwrap")" == "$bwrap_checksum" &&
       "$(digest 256 "$runtime_dir/bin/socat")" == "$socat_checksum" ]] || fail "Installed Linux runtime is damaged; remove $runtime_dir and rerun the installer."
    "$runtime_dir/bin/bwrap" --version >/dev/null
    "$runtime_dir/bin/socat" -V >/dev/null
    "$runtime_dir/bin/bwrap" --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev -- /bin/true ||
        fail "Linux sandbox helpers are installed, but the host blocks sandbox setup. Ask your administrator to enable user namespaces for bubblewrap; container users must configure nested sandbox permissions. HiCode was not switched and no system security policy was changed."
fi

# A source checkout stays developer-owned. Managed installs use immutable version
# directories so downloading or installing dependencies cannot break the old entry.
script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
fi
managed=true
if [[ -n "$script_dir" && -f "$script_dir/src/index.tsx" && -f "$script_dir/bun.lock" &&
      "$script_dir" != "$install_root/source" && "$script_dir" != "$install_root/releases/"* ]]; then
    managed=false
fi
bun_executable=$(command -v bun)
bun_bin=$(dirname "$bun_executable")
rg_bin=$(dirname "$(command -v rg)")
global_bin="$install_root/bin"
mkdir -p "$global_bin"
[[ ! -L "$global_bin/hicode" && ( ! -e "$global_bin/hicode" || -f "$global_bin/hicode" ) ]] || fail "Command destination is not a regular file: $global_bin/hicode"

if [[ "$managed" == true ]]; then
    legacy=false
    if [[ -f "$global_bin/hicode" ]]; then
        # Previous installers generated this exact two-line launcher. Recognize
        # its managed source destination without executing or sourcing its text.
        printf -v legacy_suffix ' %q "$@"' "$install_root/source/src/index.tsx"
        old_entry=$(cat "$global_bin/hicode")
        if [[ "$old_entry" == '#!/bin/bash'$'\nexec '*"$legacy_suffix" ]]; then legacy=true; fi
        if ! grep -Fqx '# HiCode managed install: peihanm/hicode' "$global_bin/hicode" && [[ "$legacy" != true ]]; then
            fail "hicode points to a source checkout or an unmanaged launcher. Update that checkout with Git; the installer will not replace it."
        fi
    fi
    if [[ ( -e "$install_root/source" || -L "$install_root/source" ) && "$legacy" != true && ! -f "$global_bin/hicode" ]]; then
        fail "Destination already exists and is not a recognized installation: $install_root/source"
    fi
    printf 'Downloading latest HiCode main...\n'
    download https://codeload.github.com/peihanm/hicode/tar.gz/refs/heads/main "$staging/source.tgz"
    archive_id=$(digest 256 "$staging/source.tgz")
    [[ "$archive_id" =~ ^[a-f0-9]{64}$ ]] || fail "Cannot identify source archive."
    mkdir -p "$install_root/releases"
    source_dir="$install_root/releases/$archive_id"
    [[ ! -L "$source_dir" ]] || fail "Release destination must not be a symlink."
    if [[ -e "$source_dir" ]]; then
        [[ -d "$source_dir" && -f "$source_dir/.install-ready" && ! -L "$source_dir/.install-ready" ]] || fail "Release destination is incomplete; refusing to overwrite it: $source_dir"
    else
        tar -xzf "$staging/source.tgz" -C "$staging"
        [[ -d "$staging/hicode-main" && ! -L "$staging/hicode-main" &&
           -f "$staging/hicode-main/src/index.tsx" && ! -L "$staging/hicode-main/src/index.tsx" &&
           -f "$staging/hicode-main/bun.lock" && ! -L "$staging/hicode-main/bun.lock" ]] || fail "Invalid HiCode source archive."
        pending_release="$source_dir"
        mv "$staging/hicode-main" "$source_dir"
        (cd "$source_dir" && bun install --frozen-lockfile --production)
    fi
else
    source_dir="$script_dir"
    printf 'Installing HiCode from %s\n' "$source_dir"
    (cd "$source_dir" && bun install --frozen-lockfile --production)
fi

# Validate before switching. The temporary launcher is on the same filesystem,
# and references the final release path; no live source directory is overwritten.
launcher_temp=$(mktemp "$global_bin/.hicode.XXXXXX")
if [[ "$managed" == true ]]; then
    printf '#!/bin/bash\n# HiCode managed install: peihanm/hicode\n' > "$launcher_temp"
else
    printf '#!/bin/bash\n# HiCode source checkout\n' > "$launcher_temp"
fi
if [[ -n "$runtime_dir" ]]; then printf 'export HICODE_LINUX_RUNTIME_DIR=%q\n' "$runtime_dir" >> "$launcher_temp"; fi
printf 'exec %q %q "$@"\n' "$bun_executable" "$source_dir/src/index.tsx" >> "$launcher_temp"
chmod 755 "$launcher_temp"
"$launcher_temp" --help >/dev/null

# Escape paths as shell syntax; preserve existing config and avoid duplicate entries.
printf -v path_line 'export PATH=%q:%q:%q:"$PATH" # HiCode installer' "$global_bin" "$bun_bin" "$rg_bin"
for startup_file in "${startup_files[@]}"; do
    [[ ! -e "$startup_file" || -f "$startup_file" ]] || fail "Not a regular shell configuration file: $startup_file"
    mkdir -p "$(dirname "$startup_file")"
    if ! grep -Fqx -- "$path_line" "$startup_file" 2>/dev/null; then
        printf '\n%s\n' "$path_line" >> "$startup_file"
    fi
done
if [[ "$managed" == true ]]; then
    printf 'ready\n' > "$source_dir/.install-ready"
fi
pending_release=""
mv -f "$launcher_temp" "$global_bin/hicode"
launcher_temp=""
# Only prune recognized installer-owned copies after the new entry is live.
# A cleanup failure must not turn a successful update into a broken rollback.
if [[ "$managed" == true ]]; then
    for previous in "$install_root/releases/"*; do
        [[ "$previous" != "$source_dir" && -d "$previous" && ! -L "$previous" ]] || continue
        [[ "${previous##*/}" =~ ^[a-f0-9]{64}$ && ! -e "$previous/.git" && ! -L "$previous/.git" ]] || continue
        [[ -f "$previous/.install-ready" && ! -L "$previous/.install-ready" ]] || continue
        [[ "$(cat "$previous/.install-ready")" == ready ]] || continue
        if ! rm -rf -- "$previous"; then
            printf 'HiCode updated, but could not remove old version: %s\n' "$previous" >&2
        fi
    done
    previous="$install_root/source"
    if [[ "$legacy" == true && -d "$previous" && ! -L "$previous" &&
          ! -e "$previous/.git" && ! -L "$previous/.git" &&
          -f "$previous/src/index.tsx" && -f "$previous/bun.lock" ]]; then
        if ! rm -rf -- "$previous"; then
            printf 'HiCode updated, but could not remove old installation: %s\n' "$previous" >&2
        fi
    fi
fi
export PATH="$global_bin:$PATH"
printf '\nHiCode installed. Open a new terminal, cd into your project, and run: hicode\n'
printf 'Source: %s\n' "$source_dir"
printf 'To update a script installation, exit HiCode and rerun the quick-start command. Existing model settings and history are preserved.\n'
