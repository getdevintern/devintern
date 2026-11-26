# Blank Debian box with systemd as PID 1 for the native-service suite
# (`test:e2e:service`). The packed CLI is installed globally for a non-root
# user the way a customer would (`bun add -g`), with Bun's global bin dir
# under that user's home.
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}-debian AS bun

FROM debian:bookworm
ENV container=docker
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session git ca-certificates curl procps expect >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /lib/systemd/system/multi-user.target.wants/getty* \
    /lib/systemd/system/sockets.target.wants/*udev* \
    /lib/systemd/system/sysinit.target.wants/systemd-udev*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN useradd -m -u 1000 -s /bin/bash tester
USER tester
WORKDIR /home/tester
ENV BUN_INSTALL=/home/tester/.bun \
  BUN_INSTALL_BIN=/home/tester/.bun/bin \
  BUN_INSTALL_GLOBAL_DIR=/home/tester/.bun/install/global \
  PATH=/home/tester/.bun/bin:/usr/local/bin:/usr/bin:/bin
COPY --chown=tester cli.tgz /tmp/cli.tgz
COPY --chown=tester --chmod=755 fake-agent.ts /home/tester/fake-agent.ts
COPY --chown=tester simple-project /home/tester/fixture
RUN bun add -g /tmp/cli.tgz >/dev/null && devintern --version
USER root
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
