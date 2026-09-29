#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { checkBoard, setupBoard } from "./board.ts";
import { checkWorkflow, type Finding } from "./check.ts";

const USAGE = `Usage:
  node src/tools.ts check [WORKFLOW.md] [--online]
  node src/tools.ts setup-board [WORKFLOW.md] [--title <board title>] [--yes]

  check        validate WORKFLOW.md; --online also compares it with the board (needs SYMPHONY_GITHUB_TOKEN)
  setup-board  create the board WORKFLOW.md describes and write its number into WORKFLOW.md`;

const print = (line: string) => process.stdout.write(`${line}\n`);

async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function report(path: string, findings: Finding[], online: boolean): number {
  const errors = findings.filter((f) => f.level === "error").length;
  for (const f of findings) print(`${f.level === "error" ? "error  " : "warning"}  ${f.message}`);
  if (findings.length === 0) print(`${path}: no problems found${online ? "" : " (add --online to also check the board)"}`);
  else print(`${path}: ${errors} error(s), ${findings.length - errors} warning(s)`);
  return errors > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        online: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        title: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const [command, file = "WORKFLOW.md"] = args.positionals;
  if (args.values.help || !command) {
    print(USAGE);
    return args.values.help ? 0 : 2;
  }
  const path = resolve(file);
  try {
    switch (command) {
      case "check": {
        const result = checkWorkflow(path);
        const findings = [...result.findings];
        if (args.values.online) findings.push(...await checkBoard(result));
        return report(path, findings, args.values.online);
      }
      case "setup-board":
        return await setupBoard({ path, env: process.env, ask, print, yes: args.values.yes, title: args.values.title });
      default:
        process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

process.exit(await main());
