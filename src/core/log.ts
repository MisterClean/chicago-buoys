export type LogLevel = "debug" | "info" | "warn" | "error";

const priority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  public constructor(private readonly threshold: LogLevel) {}

  public debug(message: string, context: Record<string, unknown> = {}): void {
    this.write("debug", message, context);
  }

  public info(message: string, context: Record<string, unknown> = {}): void {
    this.write("info", message, context);
  }

  public warn(message: string, context: Record<string, unknown> = {}): void {
    this.write("warn", message, context);
  }

  public error(message: string, context: Record<string, unknown> = {}): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context: Record<string, unknown>): void {
    if (priority[level] < priority[this.threshold]) {
      return;
    }
    const line = JSON.stringify({
      ...context,
      level,
      message,
      timestamp: new Date().toISOString(),
    });
    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
