FROM oven/bun:1.3.14 AS bun
FROM node:24-bookworm-slim AS node_runtime
FROM ubuntu:24.04

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash bubblewrap ca-certificates curl git iproute2 jq less libstdc++6 nano \
       procps python3 python3-venv ripgrep socat sudo tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login node --home /home/node --move-home ubuntu \
    && groupmod --new-name node ubuntu \
    && printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && mkdir -p /workspaces/hicode/node_modules /workspaces/lab /home/node/.hicode \
    && chown -R node:node /workspaces /home/node

ARG USER_UID=1000
RUN if [ "$(id -u node)" != "$USER_UID" ]; then usermod -u "$USER_UID" node; fi \
    && chown -R node:node /workspaces /home/node

COPY hicode /usr/local/bin/hicode
RUN chmod 0755 /usr/local/bin/hicode
ENV SHELL=/bin/bash
USER node
WORKDIR /workspaces/lab
CMD ["sleep", "infinity"]
