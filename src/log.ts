type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

const serialize = (value: unknown): unknown =>
  typeof value === "bigint"
    ? value.toString()
    : value instanceof Error
      ? value.message
      : value;

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const extra = fields
    ? " " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(serialize(v), (_k, x) => serialize(x))}`)
        .join(" ")
    : "";
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${extra}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
