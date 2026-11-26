# "Blank machine" image for the `worker init` Docker smoke suite
# (tests/docker/worker-init.test.ts, run by `bun run --filter @devintern/e2e test:docker`).
#
# A clean Debian Bun image plus git, a non-root user, and the CLI installed
# globally from a `bun pm pack` tarball, exactly as a user would install it.
# No agent CLI, no DevIntern state, no credentials. scripts/docker.ts builds it
# from a temporary context holding this file and `cli.tgz`.
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}-debian

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null \
  && rm -rf /var/lib/apt/lists/*

# Match the host uid so files a developer bind-mounts for debugging (for
# example a 0600 --env-file) stay readable. The base image's `bun` user owns
# uid 1000, so it is removed first.
ARG UID=1000
RUN userdel -r bun 2>/dev/null || true; useradd -m -u "${UID}" -s /bin/bash tester
USER tester
WORKDIR /home/tester

# oven/bun links global bins into /usr/local/bin, which a non-root user cannot
# write. Keep the global install under the user's home instead.
ENV BUN_INSTALL=/home/tester/.bun \
  BUN_INSTALL_BIN=/home/tester/.bun/bin \
  BUN_INSTALL_GLOBAL_DIR=/home/tester/.bun/install/global \
  PATH=/home/tester/.bun/bin:$PATH \
  DEVINTERN_TELEMETRY_DISABLED=1 \
  DO_NOT_TRACK=1 \
  DEVINTERN_NO_UPDATE=1

COPY --chown=tester cli.tgz /tmp/cli.tgz
RUN bun add -g /tmp/cli.tgz >/dev/null && devintern --version
