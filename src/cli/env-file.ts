import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Set `KEY=value` lines in an env file, keeping every other line. Creates the file (mode 600). */
export function setEnvValues(path: string, values: Record<string, string>, template?: string): void {
  let text = existsSync(path) ? readFileSync(path, "utf8") : template && existsSync(template) ? readFileSync(template, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}
