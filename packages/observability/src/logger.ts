import { pino, type Logger } from 'pino';
import { currentCorrelation } from './correlation.js';

/**
 * Structured JSON logging. Every line carries
 * { service, correlationId, orgId?, clientId?, siteId?, vendor? } where applicable —
 * pulled from the ambient correlation context rather than supplied at each call site,
 * so a log line cannot accidentally omit it.
 *
 * Default sink is stdout as JSON, which Railway's native log drain consumes directly.
 * OpenTelemetry is the documented upgrade path once a backend is chosen (open item 8).
 */
export interface LoggerOptions {
  readonly service: string;
  readonly level?: string | undefined;
  /**
   * Alternate sink. Production leaves this unset and writes JSON to stdout; tests pass a
   * capture stream so they can parse real emitted lines rather than trusting that a
   * correlation id *would* have been attached. The acceptance criterion is that the id
   * appears in every line from HTTP entry through persistence to fan-out, and the only
   * honest way to assert that is to read the output.
   */
  readonly destination?: NodeJS.WritableStream | undefined;
}

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.service },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    mixin() {
      const context = currentCorrelation();
      if (context === undefined) return {};
      return {
        correlationId: context.correlationId,
        ...(context.orgId !== undefined ? { orgId: context.orgId } : {}),
        ...(context.clientId !== undefined ? { clientId: context.clientId } : {}),
        ...(context.siteId !== undefined ? { siteId: context.siteId } : {}),
        ...(context.vendor !== undefined ? { vendor: context.vendor } : {}),
      };
    },
  };

  return options.destination === undefined
    ? pino(pinoOptions)
    : pino(pinoOptions, options.destination);
}

/**
 * A logger whose output is captured in memory as parsed JSON objects.
 *
 * Test-only helper, but it lives here rather than in test-support because it must use
 * the exact same createLogger path production does — a capture helper that builds its
 * own pino instance would prove nothing about the real logger's mixin.
 */
export interface CapturedLogger {
  readonly logger: Logger;
  lines(): readonly Record<string, unknown>[];
  clear(): void;
}

export function createCapturingLogger(service: string, level = 'debug'): CapturedLogger {
  const captured: Record<string, unknown>[] = [];
  const destination = {
    write(chunk: string): boolean {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        try {
          captured.push(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          // A non-JSON line means the structured-logging contract is broken, which is
          // itself worth failing on rather than quietly skipping.
          throw new Error(`Captured a non-JSON log line (${String(error)}): ${line.slice(0, 200)}`);
        }
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  return {
    logger: createLogger({ service, level, destination }),
    lines() {
      return [...captured];
    },
    clear() {
      captured.length = 0;
    },
  };
}

export type { Logger };
