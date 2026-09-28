import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Runs a program without a shell; rejects with ExecError carrying the captured output. */
export async function run(file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout, stderr };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new ExecError(`${file} ${args.join(" ")} failed: ${e.message}`, e.stdout ?? "", e.stderr ?? "");
  }
}
