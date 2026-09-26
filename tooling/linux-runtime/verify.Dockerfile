FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /workspace && chown ubuntu:ubuntu /workspace
ENV HOME=/home/ubuntu SHELL=/bin/bash
USER ubuntu
WORKDIR /workspace
CMD ["sleep", "infinity"]
