import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const setup = join(root, "scripts", "setup.sh");

function mockBin(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "symphony-setup-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  }
  return dir;
}

test("the Bash wizard runs npm ci and requests browser auth, project scope and git setup", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "symphony-setup-test-"));
  const calls = join(dir, "calls.log");
  const bin = mockBin({
    node: '#!/bin/sh\necho v22.18.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\ncase "$1" in --version) echo 'gh version 2.101.0';; api) echo setup-user;; esac\nexit 0\n`,
    npm: `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$GH_LOG"\nexit 0\n`,
  });
  const result = spawnSync("bash", [setup], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, GH_LOG: calls },
    input: "y\ny\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const log = readFileSync(calls, "utf8");
  assert.match(log, /npm ci/);
  assert.match(log, /auth status/);
  assert.match(log, /api user --jq \.login/);
  assert.match(log, /auth refresh --hostname github\.com --scopes project/);
  assert.match(log, /auth setup-git --hostname github\.com/);
  assert.match(result.stdout, /Setup complete/);
  assert.ok(result.stdout.includes(`(cd "${root}" && ./bin/symphony install-skills)`));
  assert.match(result.stdout, /GitHub CLI tested version: 2\.101\.0/);
  assert.match(result.stdout, /Existing gh installations are detected, not automatically upgraded/);
  assert.doesNotMatch(result.stdout, /token=[^\s]+|password=/i);
});

test("a missing or too-old Node is included in the install plan; declining installs nothing", { skip: process.platform === "win32" }, () => {
  const bin = mockBin({
    node: '#!/bin/sh\necho v22.17.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: '#!/bin/sh\n[ "$1" = --version ] && echo "gh version 2.80.0"\nexit 0\n',
    uname: '#!/bin/sh\necho Linux\n',
  });
  const result = spawnSync("bash", [setup], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` },
    input: "n\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Node\.js 22\.18\+ LTS \(official nodejs\.org archive \+ SHA-256 check/);
  assert.match(result.stdout, /Cancelled before installing anything/);
});

test("after confirmation, Node is downloaded from nodejs.org, checksum-verified and installed under HOME", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "symphony-node-home-"));
  const calls = join(home, "calls.log");
  const bin = mockBin({
    uname: '#!/bin/sh\n[ "$1" = -m ] && echo aarch64 || echo Linux\n',
    "apt-get": '#!/bin/sh\nexit 0\n',
    node: '#!/bin/sh\necho v20.0.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$GH_LOG"\ncase "$1" in --version) echo 'gh version 2.80.0';; api) echo setup-user;; esac\nexit 0\n`,
    npm: `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$GH_LOG"\nexit 0\n`,
    curl: `#!/bin/sh\nurl='' out=''\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done\nprintf 'curl %s\\n' "$url" >> "$GH_LOG"\nif [ "$url" = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' ]; then printf 'abc123  node-v22.99.0-linux-arm64.tar.xz\\n' > "$out"; else printf archive > "$out"; fi\n`,
    shasum: '#!/bin/sh\necho "abc123  $2"\n',
    tar: `#!/bin/sh\nout=''\nwhile [ "$#" -gt 0 ]; do case "$1" in -C) out="$2"; shift 2;; *) shift;; esac; done\nmkdir -p "$out/bin"\nprintf '#!/bin/sh\\necho v22.99.0\\n' > "$out/bin/node"\nprintf '#!/bin/sh\\n[ "$1" = --version ] && echo 11.0.0 || echo "npm $*" >> "$GH_LOG"\\n' > "$out/bin/npm"\ncp "$out/bin/npm" "$out/bin/npx"\nchmod +x "$out/bin/node" "$out/bin/npm" "$out/bin/npx"\n`,
  });
  const result = spawnSync("bash", [setup], {
    cwd: root,
    env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, GH_LOG: calls, SHELL: "/bin/bash" },
    input: "y\ny\ny\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Installed v22\.99\.0 from nodejs\.org and verified its SHA-256/);
  assert.equal(readFileSync(join(home, ".local", "share", "symphony", "node-v22", "bin", "node"), "utf8"), "#!/bin/sh\necho v22.99.0\n");
  assert.match(readFileSync(join(home, ".profile"), "utf8"), /\.local\/bin/);
  const log = readFileSync(calls, "utf8");
  assert.match(log, /curl https:\/\/nodejs\.org\/dist\/latest-v22\.x\/SHASUMS256\.txt/);
  assert.match(log, /npm ci/);
  assert.match(log, /gh auth refresh --hostname github\.com --scopes project/);
});

test("the Node installer refuses an archive whose SHA-256 does not match the official manifest", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "symphony-node-bad-hash-"));
  const bin = mockBin({
    uname: '#!/bin/sh\n[ "$1" = -m ] && echo aarch64 || echo Linux\n',
    node: '#!/bin/sh\necho v20.0.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: '#!/bin/sh\n[ "$1" = --version ] && echo "gh version 2.80.0"\nexit 0\n',
    npm: '#!/bin/sh\necho 11.0.0\n',
    "apt-get": '#!/bin/sh\nexit 0\n',
    curl: '#!/bin/sh\nout=""; url=""; while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done; if [ "$url" = "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" ]; then printf "official  node-v22.99.0-linux-arm64.tar.xz\\n" > "$out"; else printf tampered > "$out"; fi\n',
    shasum: '#!/bin/sh\necho "different  $2"\n',
  });
  const result = spawnSync("bash", [setup], {
    cwd: root,
    env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` },
    input: "y\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /checksum mismatch; refusing to install/);
  assert.equal(existsSync(join(home, ".local", "share", "symphony", "node-v24")), false);
});

test("the PowerShell entry point exists for Windows instructions", () => {
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /gh auth login/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /nodejs\.org\/dist\/latest-v/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /\$MinimumNodeMinor = 18/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /WinGet failed to install/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /GitHub CLI tested version: 2\.101\.0/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /Existing gh installations are detected, not automatically upgraded/);
});

test("Linux package installation runs directly as root and only uses sudo for non-root users", () => {
  const source = readFileSync(setup, "utf8");
  assert.match(source, /if \(\( EUID == 0 \)\); then\s+"\$@"\s+else[\s\S]*?sudo "\$@"/);
  assert.doesNotMatch(source, /sudo (?:apt-get|dnf|zypper|mkdir|chmod|install|tee)/);
});
