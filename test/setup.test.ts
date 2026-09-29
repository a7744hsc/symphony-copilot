import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    node: '#!/bin/sh\necho v24.1.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\ncase "$1" in --version) echo 'gh version 2.80.0';; api) echo setup-user;; esac\nexit 0\n`,
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
  assert.doesNotMatch(result.stdout, /token=[^\s]+|password=/i);
});

test("a missing or too-old Node version fails closed after the official-source guidance", { skip: process.platform === "win32" }, () => {
  const bin = mockBin({
    node: '#!/bin/sh\necho v20.0.0\n',
    git: '#!/bin/sh\necho "git version 2.50.0"\n',
    gh: '#!/bin/sh\n[ "$1" = --version ] && echo "gh version 2.80.0"\nexit 0\n',
    uname: '#!/bin/sh\necho Linux\n',
  });
  const result = spawnSync("bash", [setup], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` },
    input: "\n\n\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Node\.js: https:\/\/nodejs\.org\/en\/download/);
  assert.match(result.stdout, /Checking prerequisites again/);
  assert.match(result.stdout, /still missing/);
});

test("the PowerShell entry point exists for Windows instructions", () => {
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /gh auth login/);
  assert.match(readFileSync(join(root, "scripts", "setup.ps1"), "utf8"), /nodejs\.org\/en\/download/);
});
