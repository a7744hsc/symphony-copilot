#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_MAJOR=24
MIN_GIT_MINOR=38
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"

say() { printf '%s\n' "$*"; }
ask_yes() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}
open_url() {
  case "$OS" in
    Darwin) open "$1" >/dev/null 2>&1 || true ;;
    Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$1" >/dev/null 2>&1 || true ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local version major
  version="$(node --version 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR ))
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
  if ! node_ok; then say "  - Node.js ${MIN_NODE_MAJOR}+ (required)"; missing=1; else say "  ✓ Node.js $(node --version)"; fi
  if ! git_ok; then say "  - Git 2.${MIN_GIT_MINOR}+ (required for merge-tree conflict checks)"; missing=1; else say "  ✓ Git $(git --version | awk '{print $3}')"; fi
  if command -v gh >/dev/null 2>&1; then say "  ✓ GitHub CLI $(gh --version | head -n 1 | awk '{print $3}')"; else say "  - GitHub CLI (gh)"; missing=1; fi
  if command -v npm >/dev/null 2>&1; then say "  ✓ npm $(npm --version)"; else say "  - npm (bundled with Node.js)"; missing=1; fi
  return "$missing"
}

say "symphony-copilot setup — $OS"
say "This wizard checks Node.js 24+, Git and GitHub CLI, signs in through gh, then installs this checkout's npm dependencies."
say "It does not ask for, print or save your password or token."
say ""
say "Checking prerequisites:"
if ! missing_tools; then
  say ""
  case "$OS" in
    Darwin)
      say "Official installers:"
      say "  Node.js: https://nodejs.org/en/download (LTS .pkg)"
      say '  Git: Apple Command Line Tools (xcode-select --install) or https://git-scm.com/download/mac'
      say "  GitHub CLI: https://github.com/cli/cli/blob/trunk/docs/install_macos.md"
      if command -v brew >/dev/null 2>&1 && ask_yes "Install GitHub CLI using the GitHub CLI maintainers' Homebrew formula?"; then
        brew install gh || true
      fi
      if ! node_ok && ask_yes "Open the official Node.js download page now?"; then open_url "https://nodejs.org/en/download"; fi
      if ! command -v git >/dev/null 2>&1 && ask_yes "Run Apple's Command Line Tools installer? A macOS dialog will open."; then
        xcode-select --install || true
      fi
      if ask_yes "Open the official Node.js, Git and GitHub CLI installation pages?"; then
        open_url "https://nodejs.org/en/download"
        open_url "https://git-scm.com/download/mac"
        open_url "https://github.com/cli/cli/blob/trunk/docs/install_macos.md"
      fi
      ;;
    Linux)
      say "Use your distribution's official repository for Git, and GitHub CLI maintainers' instructions for gh:"
      say "  Node.js: https://nodejs.org/en/download (official LTS binaries; choose your architecture)"
      say "  Git: https://git-scm.com/download/linux"
      say "  GitHub CLI: https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
      if ask_yes "Open the official install pages in your browser?"; then
        open_url "https://nodejs.org/en/download"
        open_url "https://git-scm.com/download/linux"
        open_url "https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
      fi
      ;;
    *)
      say "Unsupported Unix platform. Install from the official sources, then rerun this wizard:"
      say "  Node.js: https://nodejs.org/en/download"
      say "  Git: https://git-scm.com/downloads"
      say "  GitHub CLI: https://github.com/cli/cli/releases/latest"
      ;;
  esac
  say ""
  say "Install the missing tools from the official source above, then return here."
  read -r -p "Press Enter to check again, or Ctrl-C to stop. " _
  say "Checking prerequisites again:"
  if ! missing_tools; then
    say "Prerequisites are still missing. Nothing was installed from an unverified source. Rerun after installing them."
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
say "Grant the GitHub Projects scope. GitHub will ask you to approve it in the browser."
gh auth refresh --hostname github.com --scopes project
say "Configure Git to use GitHub CLI credentials for pushing agent branches."
gh auth setup-git --hostname github.com
say ""
if ! gh auth status -h github.com; then
  say 'Authentication verification failed. Run `gh auth status` and fix the reported issue.'
  exit 1
fi
say ""
say 'Setup complete. Next: `symphony install-skills`, then open the target repository in Copilot and run /symphony-onboard.'
