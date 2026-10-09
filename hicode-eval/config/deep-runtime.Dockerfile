FROM {{source}}
USER root
RUN --mount=type=cache,id=hicode-deep-apt-lists,target=/var/lib/apt/lists,sharing=locked --mount=type=cache,id=hicode-deep-apt-cache,target=/var/cache/apt,sharing=locked apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bubblewrap iproute2 procps ripgrep socat sudo tmux
RUN install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -sf bun /usr/local/bin/bunx \
    && mkdir -p /eval /app /testbed /tests /logs/verifier /opt/hicode-eval /opt/hicode/releases /opt/hicode-environment
COPY package.json bun.lock /opt/hicode/
RUN --mount=type=cache,id=hicode-deep-bun,target=/root/.bun/install/cache,sharing=locked cd /opt/hicode && bun install --production --frozen-lockfile \
    && dpkg-query -W > /opt/hicode-environment/system-packages.txt
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin SHELL=/bin/bash
WORKDIR /eval
CMD ["sleep", "infinity"]
