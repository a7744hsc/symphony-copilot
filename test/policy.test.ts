import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PermissionRequest } from "@github/copilot-sdk";
import { DEFAULT_SHELL_ALLOW, DEFAULT_SHELL_DENY } from "../src/config.ts";
import { decide, ruleMatches, type PolicyOptions } from "../src/policy.ts";

const ws = mkdtempSync(join(tmpdir(), "policy-ws-"));
mkdirSync(join(ws, "src"));
const options: PolicyOptions = {
  workspace: ws,
  shellAllow: [...DEFAULT_SHELL_ALLOW, "swift", "xcodebuild", "xcrun simctl", "python3 tools/"],
  shellDeny: DEFAULT_SHELL_DENY,
  readAllow: ["/Applications/Xcode.app"],
  urlAllow: [],
};

function shell(text: string, extra: Record<string, unknown> = {}): PermissionRequest {
  const segments = text.split(/\s*(?:&&|\|\||;|\|)\s*/).map((seg) => ({ identifier: seg.split(" ")[0]!, fullCommandText: seg }));
  return {
    kind: "shell", fullCommandText: text, intention: "", canOfferSessionApproval: false, hasWriteFileRedirection: false,
    commands: segments.map((s) => ({ identifier: s.identifier, readOnly: false })), commandSegments: segments,
    possiblePaths: [], possibleUrls: [], resolvedWorkingDirectory: ws, ...extra,
  } as PermissionRequest;
}

const kind = (r: PermissionRequest) => decide(r, options).kind;

test("rules match executables or command prefixes at word boundaries", () => {
  assert.ok(ruleMatches("git", "git", "git status"));
  assert.ok(ruleMatches("git", "/usr/bin/git", "/usr/bin/git status"));
  assert.ok(ruleMatches("git push", "git", "git push origin main"));
  assert.ok(!ruleMatches("git push", "git", "git pushx"));
  assert.ok(ruleMatches("python3 tools/", "python3", "python3 tools/prepare.py"));
  assert.ok(!ruleMatches("python3 tools/", "python3", "python3 -c 'import os'"));
});

test("identifiers that include a subcommand still match (as the Copilot runtime sends them)", () => {
  assert.ok(ruleMatches("git", "git status", "git status --short"));
  assert.ok(ruleMatches("git", "git commit", "git commit -am 'x'"));
  assert.ok(ruleMatches("git push", "git push", "git push origin HEAD"));
  assert.ok(!ruleMatches("git push", "git pushx", "git pushx"));
  assert.ok(!ruleMatches("gh", "git status", "git status"));
  const real = (text: string, identifier: string) => shell(text, {
    commands: [{ identifier, readOnly: false }],
    commandSegments: [{ identifier, fullCommandText: text }],
  });
  assert.equal(kind(real("git status --short", "git status")), "approve-once");
  assert.equal(kind(real("git commit -am 'x'", "git commit")), "approve-once");
  assert.equal(kind(real("git push origin HEAD", "git push")), "reject");
  assert.equal(kind(real("xcrun simctl list", "xcrun simctl")), "approve-once");
  assert.equal(kind(real("gh pr list", "gh pr")), "reject");
});

test("allowed build and test commands run", () => {
  assert.equal(kind(shell("swift test")), "approve-once");
  assert.equal(kind(shell("xcodebuild test -scheme App -derivedDataPath work/DD")), "approve-once");
  assert.equal(kind(shell("git add -A && git commit -m 'x'")), "approve-once");
  assert.equal(kind(shell("xcrun simctl list devices")), "approve-once");
});

test("pushing, gh, network tools and unlisted programs are rejected", () => {
  for (const cmd of ["git push origin HEAD", "git status && git push", "gh pr create", "curl https://x", "npm install", "git -C /tmp status", "xcrun curl x", "python3 -c 'x'"]) {
    assert.equal(kind(shell(cmd)), "reject", cmd);
  }
});

test("shell paths outside the workspace are rejected unless read-only under an allowed root", () => {
  assert.equal(kind(shell("rm -rf /tmp/elsewhere", { possiblePaths: ["/tmp/elsewhere"] })), "reject");
  assert.equal(kind(shell("cat src/a.swift", { possiblePaths: ["src/a.swift"] })), "approve-once");
  const readOnly = { commands: [{ identifier: "ls", readOnly: true }], possiblePaths: ["/Applications/Xcode.app/Contents"] };
  assert.equal(kind(shell("ls /Applications/Xcode.app/Contents", readOnly)), "approve-once");
  assert.equal(kind(shell("ls ~/.ssh", { commands: [{ identifier: "ls", readOnly: true }], possiblePaths: [`${process.env.HOME}/.ssh`] })), "reject");
  assert.equal(kind(shell("swift test", { possibleUrls: [{ url: "https://example.com" }] })), "reject");
  assert.equal(kind(shell("swift test", { resolvedWorkingDirectory: "/tmp" })), "reject");
  assert.equal(kind(shell("swift test", { requestSandboxBypass: true })), "reject");
});

test("writes stay in the workspace, including through symlinks", () => {
  const write = (fileName: string) => ({ kind: "write", fileName, diff: "", intention: "", canOfferSessionApproval: false }) as PermissionRequest;
  assert.equal(kind(write(join(ws, "src/new.swift"))), "approve-once");
  assert.equal(kind(write("src/relative.swift")), "approve-once");
  assert.equal(kind(write(join(ws, "../escape.txt"))), "reject");
  const outside = mkdtempSync(join(tmpdir(), "policy-out-"));
  symlinkSync(outside, join(ws, "link"));
  assert.equal(kind(write(join(ws, "link/file.txt"))), "reject");
});

test("reads allow the workspace and configured roots only", () => {
  const read = (path: string) => ({ kind: "read", path, intention: "" }) as PermissionRequest;
  assert.equal(kind(read(join(ws, "README.md"))), "approve-once");
  assert.equal(kind(read("/Applications/Xcode.app/Contents/Info.plist")), "approve-once");
  assert.equal(kind(read(`${process.env.HOME}/.ssh/id_rsa`)), "reject");
});

test("urls, mcp and memory are refused; orchestrator tools and managed asks are handled", () => {
  assert.equal(kind({ kind: "url", url: "https://example.com", intention: "" } as PermissionRequest), "reject");
  assert.equal(kind({ kind: "mcp", serverName: "github", toolName: "create_issue", toolTitle: "", readOnly: false } as PermissionRequest), "reject");
  assert.equal(kind({ kind: "memory", fact: "x" } as PermissionRequest), "reject");
  assert.equal(kind({ kind: "custom-tool", toolName: "tracker_comment", toolDescription: "" } as PermissionRequest), "approve-once");
  assert.equal(kind({ ...shell("swift test"), managedApprovalRequired: true } as PermissionRequest), "user-not-available");
});
