#!/bin/sh
# Install DevIntern Code (`devintern`) on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/getdevintern/devintern/main/scripts/install.sh | sh
#
# Installs Bun when it is missing, installs @getdevintern/code globally with
# Bun, and puts Bun's global bin directory on PATH for future shells. Safe to
# re-run: each step is skipped when it is already done, and a re-run upgrades
# DevIntern to the requested version.
#
# Environment:
#   DEVINTERN_VERSION      npm version or dist-tag to install (default: latest)
#   DEVINTERN_NO_MODIFY_PATH=1  do not edit shell profiles
#   BUN_INSTALL            Bun home (default: ~/.bun), as with Bun's installer
#
# It never runs sudo. When a system package is needed and you are not root,
# it prints the command to run and exits.

set -eu

PACKAGE="@getdevintern/code"
PATH_MARKER="# Added by the DevIntern installer"

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# Print the command that installs a system package with the host's package
# manager, or nothing when no known package manager is found.
package_install_command() {
  if have apt-get; then
    printf 'apt-get update && apt-get install -y %s' "$1"
  elif have dnf; then
    printf 'dnf install -y %s' "$1"
  elif have yum; then
    printf 'yum install -y %s' "$1"
  elif have apk; then
    printf 'apk add %s' "$1"
  elif have pacman; then
    printf 'pacman -S --noconfirm %s' "$1"
  elif have zypper; then
    printf 'zypper install -y %s' "$1"
  fi
}

# Run a command with its output captured; print the output only if it fails.
quietly() {
  log=$(mktemp)
  if "$@" >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  cat "$log" >&2
  rm -f "$log"
  return 1
}

# Install a system package when running as root; otherwise print the sudo
# command for the user to run and stop.
require_package() {
  command_name=$1
  package_name=$2
  have "$command_name" && return 0

  install_command=$(package_install_command "$package_name")
  if [ -z "$install_command" ]; then
    die "'$command_name' is required. Install the '$package_name' package, then re-run this script."
  fi
  if [ "$(id -u)" -eq 0 ]; then
    say "Installing $package_name: $install_command"
    quietly sh -c "$install_command" || die "could not install $package_name"
    return 0
  fi
  printf "error: '%s' is required. Install it, then re-run this script:\n\n" "$command_name" >&2
  printf '  sudo sh -c %s\n\n' "'$install_command'" >&2
  exit 1
}

# The user's login shell: $SHELL, else the passwd entry (containers often
# leave SHELL unset), else sh.
login_shell() {
  if [ -n "${SHELL:-}" ]; then
    printf '%s' "$SHELL"
  elif have getent && entry=$(getent passwd "$(id -un)"); then
    printf '%s' "${entry##*:}"
  else
    printf 'sh'
  fi
}

# Pick the profile file the user's login shell reads.
profile_file() {
  case "$(basename "$(login_shell)")" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then
        printf '%s' "$HOME/.bash_profile"
      else
        printf '%s' "$HOME/.bashrc"
      fi
      ;;
    fish) printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# Add $1 to PATH in the shell profile, unless the profile already does.
persist_path() {
  bin_dir=$1
  if [ "${DEVINTERN_NO_MODIFY_PATH:-0}" = 1 ]; then
    return 0
  fi
  profile=$(profile_file)
  # The Bun installer writes $BUN_INSTALL/bin; an earlier run of this script
  # writes the marker. Either way, PATH is already set up.
  if [ -f "$profile" ] && grep -Eq "$PATH_MARKER|BUN_INSTALL|\\.bun/bin" "$profile"; then
    return 0
  fi
  mkdir -p "$(dirname "$profile")"
  case "$profile" in
    *.fish) line="fish_add_path \"$bin_dir\"" ;;
    *) line="export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
  printf '\n%s\n%s\n' "$PATH_MARKER" "$line" >>"$profile"
  say "Added $bin_dir to PATH in $profile"
}

path_contains() {
  case ":$2:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  os=$(uname -s)
  case "$os" in
    Linux | Darwin) ;;
    *) die "unsupported OS '$os'. DevIntern Code runs on Linux and macOS." ;;
  esac

  original_path=$PATH
  bun_home=${BUN_INSTALL:-$HOME/.bun}
  export PATH="$bun_home/bin:$PATH"

  if have bun; then
    say "Bun $(bun --version) found at $(command -v bun)"
  else
    have curl || require_package curl curl
    # Bun's installer is a bash script and unpacks a zip archive.
    have bash || require_package bash bash
    if [ "$os" = Linux ]; then
      require_package unzip unzip
    fi
    say "Installing Bun..."
    bun_installer=$(mktemp)
    trap 'rm -f "$bun_installer"' EXIT
    curl -fsSL https://bun.sh/install -o "$bun_installer" ||
      die "could not download the Bun installer from https://bun.sh/install"
    quietly bash "$bun_installer" ||
      die "Bun install failed. See https://bun.sh/docs/installation"
    have bun || die "Bun installed, but 'bun' is not in $bun_home/bin. Set BUN_INSTALL and re-run."
    say "Installed Bun $(bun --version)"
  fi

  if ! have git; then
    warn "git is not installed. DevIntern needs it to run tasks. $(package_install_command git)"
  fi

  version=${DEVINTERN_VERSION:-latest}
  say "Installing $PACKAGE@$version..."
  quietly bun install -g "$PACKAGE@$version" || die "bun install -g $PACKAGE@$version failed"

  global_bin=$(bun pm bin -g 2>/dev/null || printf '%s' "$bun_home/bin")
  export PATH="$global_bin:$PATH"
  have devintern || die "devintern was installed but is not in $global_bin"
  persist_path "$global_bin"

  say ""
  # Run from / so a checkout's settings are not picked up or migrated here.
  installed_version=$(cd / && devintern --version 2>/dev/null | tail -n 1)
  say "devintern $installed_version installed at $(command -v devintern)"
  say ""
  if ! path_contains "$global_bin" "$original_path"; then
    say "To use it in this terminal, run (new terminals pick it up automatically):"
    say ""
    say "  export PATH=\"$global_bin:\$PATH\""
    say ""
  fi
  if ! have claude && ! have codex && ! have cursor-agent && ! have opencode; then
    say "Install and sign in to a coding agent, for example Claude Code:"
    say ""
    say "  curl -fsSL https://claude.ai/install.sh | bash && claude"
    say ""
  fi
  say "Next, in your project's checkout:"
  say ""
  say "  devintern worker init"
}

# Everything runs from here, so a partially downloaded script does nothing.
main "$@"
