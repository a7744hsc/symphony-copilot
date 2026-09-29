#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
NODE_INSTALL_MAJOR=24
MIN_GIT_MINOR=38
NODE_DIST_BASE="https://nodejs.org/dist/latest-v${NODE_INSTALL_MAJOR}.x"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"

say() { printf '%s\n' "$*"; }
ask_yes() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}
node_archive_platform() {
  local arch
  arch="$(uname -m)"
  case "$OS:$arch" in
    Darwin:arm64|Darwin:aarch64) printf 'darwin-arm64' ;;
    Darwin:x86_64) printf 'darwin-x64' ;;
    Linux:aarch64|Linux:arm64) printf 'linux-arm64' ;;
    Linux:x86_64|Linux:amd64) printf 'linux-x64' ;;
    *) return 1 ;;
  esac
}

install_node_user() {
  local platform sums archive expected actual home_bin install_dir temp_dir shell_name rc_file export_line hash_cmd
  local -a rc_files
  platform="$(node_archive_platform)" || { say "Unsupported Node.js architecture: $OS/$(uname -m)"; return 1; }
  for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || { say "Cannot install Node.js automatically: missing $tool."; return 1; }; done
  if command -v shasum >/dev/null 2>&1; then
    hash_cmd=shasum
  elif command -v sha256sum >/dev/null 2>&1; then
    hash_cmd=sha256sum
  else
    say "Cannot verify the official Node.js checksum: install shasum/sha256sum first."
    return 1
  fi
  sums="$(mktemp)"
  if ! curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$NODE_DIST_BASE/SHASUMS256.txt" -o "$sums"; then
    rm -f "$sums"
    return 1
  fi
  archive="$(awk -v p="$platform" -v major="$NODE_INSTALL_MAJOR" '$2 ~ ("^node-v" major "\\.[0-9]+\\.[0-9]+-" p "\\.tar\\.xz$") {print $2; exit}' "$sums")"
  if [[ -z "$archive" ]]; then rm -f "$sums"; say "No official Node.js archive for $platform."; return 1; fi
  expected="$(awk -v f="$archive" '$2 == f {print $1; exit}' "$sums")"
  temp_dir="$(mktemp -d)"
  if ! curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$NODE_DIST_BASE/$archive" -o "$temp_dir/$archive"; then
    rm -rf "$temp_dir"; rm -f "$sums"; return 1
  fi
  if [[ "$hash_cmd" == shasum ]]; then actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')"; else actual="$(sha256sum "$temp_dir/$archive" | awk '{print $1}')"; fi
  rm -f "$sums"
  if [[ "$actual" != "$expected" ]]; then rm -rf "$temp_dir"; say "Node.js archive checksum mismatch; refusing to install."; return 1; fi
  home_bin="$HOME/.local/bin"
  install_dir="$HOME/.local/share/symphony/node-v${NODE_INSTALL_MAJOR}"
  mkdir -p "$home_bin" "$(dirname "$install_dir")"
  tar -xJf "$temp_dir/$archive" -C "$temp_dir" --strip-components=1
  rm -f "$temp_dir/$archive"
  rm -rf "$install_dir"
  mv "$temp_dir" "$install_dir"
  ln -sf "$install_dir/bin/node" "$home_bin/node"
  ln -sf "$install_dir/bin/npm" "$home_bin/npm"
  ln -sf "$install_dir/bin/npx" "$home_bin/npx"
  export PATH="$home_bin:$PATH"
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) rc_files=("$HOME/.zprofile" "$HOME/.zshrc") ;;
    bash) rc_files=("$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc") ;;
    *) rc_files=("$HOME/.profile") ;;
  esac
  export_line='export PATH="$HOME/.local/bin:$PATH"'
  for rc_file in "${rc_files[@]}"; do
    if [[ ! -f "$rc_file" ]] || ! grep -Fq "$export_line" "$rc_file"; then printf '\n%s\n' "$export_line" >> "$rc_file"; fi
  done
  PATH="$home_bin:$PATH"
  export PATH
  say "Installed $("$home_bin/node" --version) from the official Node.js LTS archive and verified its SHA-256."
  say "Added $home_bin to PATH in ${rc_files[*]} (new login and interactive shells will pick it up)."
}

detect_linux_pm() {
  if command -v apt-get >/dev/null 2>&1; then printf apt
  elif command -v dnf >/dev/null 2>&1; then printf dnf
  elif command -v zypper >/dev/null 2>&1; then printf zypper
  else printf unsupported
  fi
}

run_privileged() {
  if (( EUID == 0 )); then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || { say "This install needs administrator rights; install sudo or rerun as root."; return 1; }
    sudo "$@"
  fi
}

download_tools_ok() {
  command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 && command -v xz >/dev/null 2>&1 && { command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1; }
}

install_download_tools() {
  local linux_pm="$1"
  case "$OS:$linux_pm" in
    Darwin:*)
      if command -v brew >/dev/null 2>&1; then brew install curl xz || return 1
      else say "Missing download/archive utilities (curl, tar, xz or SHA-256); install them and rerun."; return 1; fi
      ;;
    Linux:apt) run_privileged apt-get update && run_privileged apt-get install -y curl tar xz-utils ca-certificates coreutils || return 1 ;;
    Linux:dnf) run_privileged dnf install -y curl tar xz ca-certificates coreutils || return 1 ;;
    Linux:zypper) run_privileged zypper --non-interactive install curl tar xz ca-certificates coreutils || return 1 ;;
    *) say "Cannot install the required download/archive utilities on this platform."; return 1 ;;
  esac
  hash -r
  download_tools_ok || { say "Download/archive utilities are still unavailable after installation."; return 1; }
}

install_confirmed_tools() {
  local linux_pm="$1"
  local shell_name rc_file export_line
  local -a rc_files
  if ! download_tools_ok; then install_download_tools "$linux_pm" || return 1; fi
  if ! node_ok; then install_node_user || return 1; fi
  if ! command -v copilot >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/bin"
    npm_config_ignore_scripts=false npm install --global --prefix "$HOME/.local" @github/copilot || return 1
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    shell_name="$(basename "${SHELL:-sh}")"
    case "$shell_name" in
      zsh) rc_files=("$HOME/.zprofile" "$HOME/.zshrc") ;;
      bash) rc_files=("$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc") ;;
      *) rc_files=("$HOME/.profile") ;;
    esac
    export_line='export PATH="$HOME/.local/bin:$PATH"'
    for rc_file in "${rc_files[@]}"; do
      if [[ ! -f "$rc_file" ]] || ! grep -Fq "$export_line" "$rc_file"; then printf '\n%s\n' "$export_line" >> "$rc_file"; fi
    done
  fi
  case "$OS" in
    Darwin)
      if ! git_ok; then
        if command -v brew >/dev/null 2>&1; then brew install git || return 1
        else say "Automatic Git install requires Homebrew; please install Git from Apple Command Line Tools and rerun."; return 1; fi
      fi
      if ! command -v gh >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then brew install gh || return 1
        else say "Automatic GitHub CLI install requires Homebrew; please install gh per https://github.com/cli/cli/blob/trunk/docs/install_macos.md and rerun."; return 1; fi
      fi
      ;;
    Linux)
      case "$linux_pm" in
        apt)
          if ! git_ok; then run_privileged apt-get update && run_privileged apt-get install -y git || return 1; fi
          if ! command -v gh >/dev/null 2>&1; then
            run_privileged mkdir -p -m 755 /etc/apt/keyrings || return 1
            curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 https://cli.github.com/packages/githubcli-archive-keyring.gpg | run_privileged tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null || return 1
            run_privileged chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg || return 1
            run_privileged mkdir -p -m 755 /etc/apt/sources.list.d || return 1
            printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" | run_privileged tee /etc/apt/sources.list.d/github-cli.list >/dev/null || return 1
            run_privileged apt-get update && run_privileged apt-get install -y gh || return 1
          fi
          ;;
        dnf)
          if ! git_ok; then run_privileged dnf install -y git || return 1; fi
          if ! command -v gh >/dev/null 2>&1; then
            local repo_file
            repo_file="$(mktemp)"
            curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 https://cli.github.com/packages/rpm/gh-cli.repo -o "$repo_file" || { rm -f "$repo_file"; return 1; }
            run_privileged install -m 0644 "$repo_file" /etc/yum.repos.d/gh-cli.repo || { rm -f "$repo_file"; return 1; }
            rm -f "$repo_file"
            run_privileged dnf install -y gh || return 1
          fi
          ;;
        zypper)
          if ! git_ok; then run_privileged zypper --non-interactive install git || return 1; fi
          if ! command -v gh >/dev/null 2>&1; then
            run_privileged zypper addrepo https://cli.github.com/packages/rpm/gh-cli.repo gh-cli && run_privileged zypper --non-interactive refresh gh-cli && run_privileged zypper --non-interactive install gh || return 1
          fi
          ;;
        *) say "No supported official package manager detected; cannot automatically install Git/gh on this Linux distribution."; return 1 ;;
      esac
      ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local version major minor
  version="$(node --version 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) ))
}
git_ok() {
  command -v git >/dev/null 2>&1 || return 1
  local version major minor
  version="$(git --version 2>/dev/null | awk '{print $3}')"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > 2 || (major == 2 && minor >= MIN_GIT_MINOR) ))
}
missing_tools() {
  local missing=0
  if ! node_ok; then say "  - Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ (required)"; missing=1; else say "  ✓ Node.js $(node --version)"; fi
  if ! git_ok; then say "  - Git 2.${MIN_GIT_MINOR}+ (required for merge-tree conflict checks)"; missing=1; else say "  ✓ Git $(git --version | awk '{print $3}')"; fi
  if command -v gh >/dev/null 2>&1; then say "  ✓ GitHub CLI $(gh --version | head -n 1 | awk '{print $3}')"; else say "  - GitHub CLI (gh)"; missing=1; fi
  if command -v copilot >/dev/null 2>&1; then say "  ✓ Copilot CLI $(copilot --version 2>/dev/null | head -n 1)"; else say "  - GitHub Copilot CLI (copilot)"; missing=1; fi
  if command -v npm >/dev/null 2>&1; then say "  ✓ npm $(npm --version)"; else say "  - npm (bundled with Node.js)"; missing=1; fi
  if download_tools_ok; then say "  ✓ Node download/checksum utilities"; else say "  - Node download/checksum utilities (curl, tar, xz, SHA-256 tool)"; missing=1; fi
  return "$missing"
}

say "symphony-copilot setup — $OS"
say "This wizard checks Node.js 22.18+, Git, GitHub CLI and Copilot CLI, signs in to both services, then installs this checkout's npm dependencies."
say "GitHub CLI tested version: 2.101.0 (2026-09-29). Existing gh installations are detected, not automatically upgraded."
say "The wizard does not handle tokens directly; gh and Copilot CLI store credentials using their normal auth flows."
say ""
say "Checking prerequisites:"
if ! missing_tools; then
  linux_pm=unsupported
  [[ "$OS" != Linux ]] || linux_pm="$(detect_linux_pm)"
  if [[ "$OS" == Darwin ]] && ! command -v brew >/dev/null 2>&1 && { ! git_ok || ! command -v gh >/dev/null 2>&1; }; then
    say "This Mac has no Homebrew, so the wizard cannot automatically install the missing Git/GitHub CLI tools. Nothing has been installed."
    say "Install Homebrew from https://brew.sh (if you choose), or use Apple's Command Line Tools for Git and the GitHub CLI maintainer instructions for gh; then rerun."
    exit 1
  fi
  if [[ "$OS" == Linux && "$linux_pm" == unsupported ]] && { ! git_ok || ! command -v gh >/dev/null 2>&1; }; then
    say "No supported official apt/dnf/zypper package manager was detected for the missing Git/GitHub CLI tools. Nothing has been installed."
    say "Install them using your distribution's official repository and the GitHub CLI maintainer instructions, then rerun."
    exit 1
  fi
  if [[ "$OS" == Linux && "$EUID" != 0 ]] && { ! git_ok || ! command -v gh >/dev/null 2>&1; } && ! command -v sudo >/dev/null 2>&1; then
    say "Installing Git/GitHub CLI from system repositories needs root or sudo, but sudo is not installed. Nothing has been installed."
    say "Rerun as root (for example, inside a disposable container) or install sudo first."
    exit 1
  fi
  say ""
  say "The following missing tools will be installed after your confirmation:"
  if ! download_tools_ok; then say "  - Node download/checksum utilities (curl, tar, xz and SHA-256 tool) via the supported package manager"; fi
  ! node_ok && say "  - Current Node.js LTS (Node ${NODE_INSTALL_MAJOR}; satisfies minimum ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+) from official nodejs.org archive + SHA-256 check; user directory, no sudo)"
  if ! git_ok; then
    case "$OS:$linux_pm" in
      Darwin:*) say "  - Git 2.38+ via Homebrew (or Apple Command Line Tools if Homebrew is unavailable)" ;;
      Linux:apt) say "  - Git 2.38+ via apt ($([[ "$EUID" == 0 ]] && printf 'running as root' || printf 'sudo required'))" ;;
      Linux:dnf) say "  - Git 2.38+ via dnf ($([[ "$EUID" == 0 ]] && printf 'running as root' || printf 'sudo required'))" ;;
      Linux:zypper) say "  - Git 2.38+ via zypper ($([[ "$EUID" == 0 ]] && printf 'running as root' || printf 'sudo required'))" ;;
      *) say "  - Git 2.38+ (manual installation required on this platform)" ;;
    esac
  fi
  if ! command -v gh >/dev/null 2>&1; then
    case "$OS:$linux_pm" in
      Darwin:*) say "  - GitHub CLI via Homebrew" ;;
      Linux:apt|Linux:dnf|Linux:zypper) say "  - GitHub CLI from the GitHub CLI maintainers' official repository ($([[ "$EUID" == 0 ]] && printf 'running as root' || printf 'sudo required'))" ;;
      *) say "  - GitHub CLI (manual installation required on this platform)" ;;
    esac
  fi
  if ! command -v copilot >/dev/null 2>&1; then
    say "  - GitHub Copilot CLI from official npm package @github/copilot (user-local prefix; no sudo)"
  fi
  if [[ "$OS" != Darwin && "$OS" != Linux ]]; then say "This platform is not supported by the Unix installer; use scripts/setup.ps1 on Windows."; exit 1; fi
  if ask_yes "Proceed with these installations?"; then
    install_confirmed_tools "$linux_pm"
  else
    say "Cancelled before installing anything."
    exit 1
  fi
  say "Checking prerequisites again:"
  if ! missing_tools; then
    say "Some prerequisites are still missing. Fix the reported package-manager error and rerun this wizard."
    exit 1
  fi
fi

say ""
if [[ -f "$ROOT/package-lock.json" ]]; then
  if ask_yes "Install this checkout's npm dependencies with npm ci?"; then
    (cd "$ROOT" && npm ci)
  else
    say "Skipped npm ci. Run it before using this checkout."
  fi
else
  if ask_yes "Install this checkout's npm dependencies with npm install?"; then
    (cd "$ROOT" && npm install)
  else
    say "Skipped npm install. Run it before using this checkout."
  fi
fi

say ""
say "GitHub and Copilot sign-in:"
logged_in=0
if gh auth status -h github.com >/dev/null 2>&1; then
  account="$(gh api user --jq .login 2>/dev/null || true)"
  say "GitHub CLI is already signed in${account:+ as $account}."
  if ask_yes "Reuse this account?"; then logged_in=1; fi
fi
if (( ! logged_in )); then
  say "Starting GitHub's browser sign-in through the official GitHub CLI."
  gh auth login --hostname github.com --git-protocol https --web
fi

say ""
project_scopes="$(gh auth status --hostname github.com --json hosts --jq '.hosts["github.com"][] | select(.active) | .scopes // ""' 2>/dev/null || true)"
if printf '%s\n' "$project_scopes" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Fxq project; then
  say "The active GitHub account already has the Projects scope; skipping authorization."
else
  say "Grant the GitHub Projects scope. GitHub will ask you to approve it in the browser."
  gh auth refresh --hostname github.com --scopes project
fi
say "Configure Git to use GitHub CLI credentials for pushing agent branches."
gh auth setup-git --hostname github.com
say ""
if ! gh auth status -h github.com; then
  say 'Authentication verification failed. Run `gh auth status` and fix the reported issue.'
  exit 1
fi
say ""
say "GitHub CLI authentication is complete. Choose how to authenticate Copilot CLI:"
say "  1) Device code — visit github.com/login/device and enter the code (recommended for containers/remote shells)"
say "  2) Browser link — open the OAuth link in a local browser"
say "Copilot CLI uses the OS keychain when available; headless Linux without a keychain may offer plaintext storage in ~/.copilot/config.json."
while true; do
  if ! read -r -p "Copilot login method [1/2, default 1]: " copilot_login_method; then
    say "No Copilot login method was selected."
    exit 1
  fi
  copilot_login_method="${copilot_login_method:-1}"
  case "$copilot_login_method" in
    1) copilot login --device-code; break ;;
    2) copilot login --web-flow; break ;;
    *) say "Choose 1 for device code or 2 for browser link." ;;
  esac
done
say "Setup complete. Next: run (cd \"$ROOT\" && ./bin/symphony install-skills), then open the target repository in Copilot and run /symphony-onboard."
