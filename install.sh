#!/bin/bash
set -euo pipefail

fail() { printf 'Pillar install: %s\n' "$*" >&2; exit 1; }
trap 'printf "Pillar installation failed. Fix the error above and rerun the installer.\n" >&2' ERR

[[ "$(uname -s)" == Darwin ]] || fail "Only macOS is supported."
[[ $EUID -ne 0 ]] || fail "Run this script as your normal user, without sudo."
case "${SHELL##*/}" in
    zsh) startup_files=("${ZDOTDIR:-$HOME}/.zshrc") ;;
    bash)
        if [[ -e "$HOME/.bash_profile" ]]; then login_file="$HOME/.bash_profile"
        elif [[ -e "$HOME/.bash_login" ]]; then login_file="$HOME/.bash_login"
        elif [[ -e "$HOME/.profile" ]]; then login_file="$HOME/.profile"
        else login_file="$HOME/.bash_profile"; fi
        startup_files=("$login_file" "$HOME/.bashrc") ;;
    *) fail "Automatic setup supports zsh and bash. Switch to one of these login shells first." ;;
esac

# Find existing installations even before the user's shell has a working PATH.
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
missing=()
command -v git >/dev/null && git --version >/dev/null 2>&1 || missing+=(git)
command -v rg >/dev/null || missing+=(ripgrep)
bun_supported() {
    local version major minor
    command -v bun >/dev/null || return 1
    version=$(bun --version) || return 1
    [[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]] || return 1
    major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}
    (( major > 1 || (major == 1 && minor >= 3) ))
}
bun_supported || missing+=(oven-sh/bun/bun)

if (( ${#missing[@]} )); then
    if ! command -v brew >/dev/null; then
        printf 'Installing Homebrew for missing dependencies. Its installer may request your macOS password.\n'
        brew_script=$(mktemp -t pillar-homebrew)
        trap 'rm -f "$brew_script"' EXIT
        curl --fail --silent --show-error --location https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$brew_script"
        /bin/bash "$brew_script"
        rm -f "$brew_script"
        trap - EXIT
    fi
    command -v brew >/dev/null || fail "Homebrew was not installed successfully."
    brew install "${missing[@]}"
    # Prefer the Homebrew Bun if an older custom installation shadows it.
    if ! bun_supported; then
        brew_bun=$(brew --prefix oven-sh/bun/bun)
        export PATH="$brew_bun/bin:$PATH"
    fi
fi
bun_supported || fail "Bun 1.3 or newer is required."
git --version >/dev/null
rg --version >/dev/null

# A checked-out install.sh uses that checkout; a downloaded script fetches source.
script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
fi
if [[ -n "$script_dir" && -f "$script_dir/src/index.tsx" && -f "$script_dir/bun.lock" ]]; then
    source_dir="$script_dir"
else
    source_dir="$HOME/.local/share/pillar/source"
    if [[ -e "$source_dir" ]]; then
        [[ -d "$source_dir/.git" && -f "$source_dir/src/index.tsx" ]] || fail "Destination already exists: $source_dir. It was left unchanged."
        [[ "$(git -C "$source_dir" remote get-url origin)" == https://github.com/peihanm/pillar-core.git ]] || fail "Destination belongs to another repository: $source_dir"
        printf 'Reusing %s without changing its Git checkout.\n' "$source_dir"
    else
        mkdir -p "$(dirname "$source_dir")"
        git clone --depth 1 https://github.com/peihanm/pillar-core.git "$source_dir"
    fi
fi

cd "$source_dir"
printf 'Installing Pillar from %s\n' "$source_dir"
bun install --frozen-lockfile
bun link
global_bin=$(bun pm bin -g)
[[ "$global_bin" == /* && -x "$global_bin/pillar" ]] || fail "Bun did not create the pillar executable."
bun_bin=$(dirname "$(command -v bun)")
rg_bin=$(dirname "$(command -v rg)")
git_bin=$(dirname "$(command -v git)")

# Escape paths as shell syntax; preserve existing config and avoid duplicate entries.
printf -v path_line 'export PATH=%q:%q:%q:%q:"$PATH" # Pillar installer' "$global_bin" "$bun_bin" "$rg_bin" "$git_bin"
for startup_file in "${startup_files[@]}"; do
    [[ ! -e "$startup_file" || -f "$startup_file" ]] || fail "Not a regular shell configuration file: $startup_file"
    mkdir -p "$(dirname "$startup_file")"
    if ! grep -Fqx -- "$path_line" "$startup_file" 2>/dev/null; then
        printf '\n%s\n' "$path_line" >> "$startup_file"
    fi
done
export PATH="$global_bin:$PATH"
pillar --help >/dev/null
printf '\nPillar installed. Open a new terminal, cd into your project, and run: pillar\n'
printf 'On first launch, configure your API key and select a model.\n'
