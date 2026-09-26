#!/usr/bin/env bash
set -euo pipefail

task_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
docker_context=${HICODE_DOCKER_CONTEXT:-colima-hicode}
compose() {
    local task_uid
    task_uid=$(id -u)
    [[ "$task_uid" != 0 ]] || task_uid=1000
    # Compose owns optional .env parsing for both builds and runtime. Do not
    # source user configuration or let the caller's current directory select it.
    HICODE_DEV_UID="$task_uid" docker --context "$docker_context" compose \
        --project-directory "$task_dir" -f "$task_dir/compose.yaml" "$@"
}
build_image() {
    compose build "$@" dev
}
ensure_engine() {
    if [[ "$docker_context" == colima-hicode ]]; then
        if ! colima --profile hicode status >/dev/null 2>&1; then
            colima start hicode
        fi
    fi
    docker --context "$docker_context" info >/dev/null
}
prepare_profile() {
    if [[ "$docker_context" == colima-hicode ]]; then
        colima --profile hicode ssh -- sudo apparmor_parser -r "$task_dir/apparmor-hicode"
    fi
}
ensure_running() {
    ensure_engine
    if [[ -z "$(compose ps --status running -q dev)" ]]; then
        prepare_profile
        if [[ -n "$(compose ps --all -q dev)" ]]; then
            compose start dev
        else
            if ! docker --context "$docker_context" image inspect hicode-ubuntu:dev >/dev/null 2>&1; then
                build_image
            fi
            compose up -d --no-deps dev
            compose exec -T -w /workspaces/hicode dev bun install --frozen-lockfile
        fi
    fi
}
enter_linux() {
    ensure_running
    # Docker's PTY defaults to xterm/16 colors. Preserve each attaching terminal's
    # capabilities instead of changing the shared container's palette globally.
    local terminal_env=(--env "TERM=${TERM:-xterm}")
    local terminal_name terminal_value
    for terminal_name in COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION COLORFGBG FORCE_COLOR NO_COLOR; do
        if terminal_value=$(printenv "$terminal_name"); then
            terminal_env+=(--env "$terminal_name=$terminal_value")
        fi
    done
    compose exec "${terminal_env[@]}" -w /workspaces/lab dev bash -l
}

case "${1:-enter}" in
    enter|shell)
        enter_linux
        ;;
    start)
        ensure_running
        ;;
    install-command)
        command_dir="$HOME/.local/bin"
        launcher="$command_dir/hicode-linux"
        marker='# HiCode Linux launcher'
        if [[ -L "$launcher" || ( -e "$launcher" && ! -f "$launcher" ) ]] ||
            { [[ -f "$launcher" ]] && ! grep -Fqx "$marker" "$launcher"; }; then
            echo "Refusing to replace an existing unrelated command: $launcher" >&2
            exit 1
        fi
        mkdir -p "$command_dir"
        launcher_temp=$(mktemp "$command_dir/.hicode-linux.XXXXXX")
        trap 'rm -f -- "$launcher_temp"' EXIT
        printf '#!/bin/bash\n%s\nexec /bin/bash %q "$@"\n' "$marker" "$task_dir/linux.sh" > "$launcher_temp"
        chmod 0755 "$launcher_temp"
        mv -f "$launcher_temp" "$launcher"
        echo "Installed $launcher. Run hicode-linux from any directory with ~/.local/bin on PATH."
        ;;
    stop)
        compose stop
        ;;
    status)
        compose ps
        ;;
    rebuild)
        ensure_engine
        prepare_profile
        build_image --pull
        compose up -d --no-deps dev
        compose exec -T -w /workspaces/hicode dev bun install --frozen-lockfile
        ;;
    *)
        echo "Usage: hicode-linux [enter|start|stop|status|rebuild|install-command]" >&2
        exit 2
        ;;
esac
