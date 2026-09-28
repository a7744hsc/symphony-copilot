export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function formatValue(value: unknown): string {
  if (value instanceof Error) value = value.message;
  if (value === null || value === undefined) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
}

export function formatLine(level: Level, msg: string, fields: LogFields, now = new Date()): string {
  const parts = [`ts=${now.toISOString()}`, `level=${level}`, `msg=${formatValue(msg)}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

/** key=value lines on stderr; a failing sink never throws into the caller. */
export function createLogger(minLevel: Level = "info", base: LogFields = {}, sink: (line: string) => void = (line) => process.stderr.write(line + "\n")): Logger {
  const emit = (level: Level, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    try {
      sink(formatLine(level, msg, { ...base, ...fields }));
    } catch {
      // Logging must not take the orchestrator down.
    }
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(minLevel, { ...base, ...fields }, sink),
  };
}

export function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length - max} more chars)`;
}
