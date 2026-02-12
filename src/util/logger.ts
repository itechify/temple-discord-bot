export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function write(level: string, message: string, meta?: unknown): void {
  const stamp = new Date().toISOString();
  if (meta === undefined) {
    console.log(`[${stamp}] [${level}] ${message}`);
    return;
  }

  console.log(`[${stamp}] [${level}] ${message}`, meta);
}

export const logger: Logger = {
  info: (message, meta) => write("INFO", message, meta),
  warn: (message, meta) => write("WARN", message, meta),
  error: (message, meta) => write("ERROR", message, meta),
};
