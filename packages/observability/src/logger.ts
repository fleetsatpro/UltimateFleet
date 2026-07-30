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
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.service },
    formatters: {
      level: (label) => ({ level: label }),
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
  });
}

export type { Logger };
