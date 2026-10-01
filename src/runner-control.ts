import { chmodSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import type { RunnerRecord } from "./instances.ts";

export type RunnerState = "starting" | "running" | "stopping";

export async function serveRunner(
  run: NonNullable<RunnerRecord["run"]>,
  state: () => RunnerState,
  stop: () => void,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.setTimeout(2_000, () => socket.destroy());
    let input = "";
    socket.on("error", () => socket.destroy());
    socket.on("data", (data) => {
      input += data.toString();
      if (input.length > 1024) return socket.destroy();
      if (!input.includes("\n")) return;
      let request: unknown;
      try { request = JSON.parse(input); } catch { socket.destroy(); return; }
      if (!request || typeof request !== "object" || !("nonce" in request) || request.nonce !== run.nonce ||
        !("command" in request) || !["status", "stop"].includes(String(request.command))) {
        socket.destroy();
        return;
      }
      if (request.command === "stop") stop();
      socket.end(`${JSON.stringify({ nonce: run.nonce, state: state() })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(run.socket, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(run.socket, 0o600);
  return server;
}

export function requestRunner(record: RunnerRecord, command: "status" | "stop"): Promise<RunnerState> {
  const run = record.run;
  if (!run) return Promise.reject(new Error(`runner "${record.id}" is not running`));
  return new Promise((resolve, reject) => {
    const socket = createConnection(run.socket);
    let input = "";
    let answered = false;
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(3_000, () => fail(new Error(`runner "${record.id}" control request timed out; no process was signaled`)));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify({ nonce: run.nonce, command })}\n`));
    socket.on("data", (data) => {
      input += data.toString();
      if (input.length > 1024) return fail(new Error("invalid runner control response"));
      if (!input.includes("\n")) return;
      try {
        const response = JSON.parse(input);
        if (response.nonce !== run.nonce || !["starting", "running", "stopping"].includes(response.state)) {
          throw new Error("runner control identity mismatch; no process was signaled");
        }
        answered = true;
        socket.end();
        resolve(response.state);
      } catch (error) { fail(error as Error); }
    });
    socket.on("close", () => { if (!answered) reject(new Error(`runner "${record.id}" control connection closed without a response`)); });
  });
}
