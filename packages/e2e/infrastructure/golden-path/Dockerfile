# Blank Debian box with systemd as PID 1 for the onboarding golden path
# (`test:e2e:golden-path`).
#
# Unlike infrastructure/service, the CLI is NOT installed here and the image
# sets no PATH, BUN_INSTALL or other user environment: the suite installs the
# CLI at run time with `bun add -g` from a login shell (`bash -l`), so a PATH
# problem after a global install fails the run the way it would for a user.
#
# Bun sits in each user's ~/.bun/bin with its PATH line in ~/.profile, the
# layout Bun's official installer leaves. Two users: `tester` (uid 1000)
# drives the non-interactive path and the service, `newcomer` (uid 1001) runs
# the interactive wizard on an untouched home. No git identity, no agent CLI,
# no DevIntern state, no credentials.
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}-debian AS bun

FROM debian:bookworm
ENV container=docker
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session git ca-certificates curl procps >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /lib/systemd/system/multi-user.target.wants/getty* \
    /lib/systemd/system/sockets.target.wants/*udev* \
    /lib/systemd/system/sysinit.target.wants/systemd-udev*
COPY --from=bun /usr/local/bin/bun /opt/bun/bun
RUN for user in tester newcomer; do \
    useradd -m -s /bin/bash "$user" \
    && install -d -o "$user" -g "$user" "/home/$user/.bun" "/home/$user/.bun/bin" \
    && install -o "$user" -g "$user" -m 755 /opt/bun/bun "/home/$user/.bun/bin/bun" \
    && printf '\n# bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' \
      >> "/home/$user/.profile" || exit 1; \
  done \
  && rm -rf /opt/bun
# The deterministic agent stands in for a real agent CLI (no AI account in CI).
COPY --chmod=755 fake-agent.ts /opt/e2e/fake-agent.ts
# The project pushed to the run's unique base branch of the fixture repository.
COPY simple-project /opt/e2e/fixture
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
