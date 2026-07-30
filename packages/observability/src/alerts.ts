import type { Logger } from 'pino';
import { currentCorrelation } from './correlation.js';

/**
 * Alerting, kept deliberately distinct from logging.
 *
 * The brief is explicit that some conditions must ALERT, not merely log — a
 * silently-open circuit breaker quietly serving degraded data is a worse failure mode
 * than a visible outage. Same reasoning applies to an unmapped vendor event code: the
 * event still persists as 'unknown', so nothing breaks, and without an alert nobody
 * ever adds the mapping row.
 *
 * The real sink (PagerDuty, Opsgenie, whatever the team runs) is wired in Phase 12,
 * which is why this is an interface with a recording implementation rather than a
 * client for a service nobody has chosen yet (open item 8).
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertContext {
  readonly severity: AlertSeverity;
  readonly [key: string]: unknown;
}

export interface FiredAlert {
  readonly name: string;
  readonly severity: AlertSeverity;
  readonly context: Readonly<Record<string, unknown>>;
  readonly correlationId: string | undefined;
  readonly firedAt: Date;
}

export interface Alerts {
  fire(name: string, context: AlertContext): void;
  /** Alerts fired so far. Exists so tests can assert "exactly one alert", not for app logic. */
  fired(): readonly FiredAlert[];
  clear(): void;
}

export function createAlerts(logger: Logger): Alerts {
  const history: FiredAlert[] = [];

  return {
    fire(name, context) {
      const { severity, ...rest } = context;
      const correlation = currentCorrelation();
      const alert: FiredAlert = {
        name,
        severity,
        context: rest,
        correlationId: correlation?.correlationId,
        firedAt: new Date(),
      };
      history.push(alert);
      // Also logged, at a level matching severity — an alert nobody can find in the
      // logs afterwards is hard to investigate.
      const line = { alert: name, severity, ...rest };
      if (severity === 'critical') logger.error(line, `ALERT ${name}`);
      else if (severity === 'warning') logger.warn(line, `ALERT ${name}`);
      else logger.info(line, `ALERT ${name}`);
    },
    fired() {
      return [...history];
    },
    clear() {
      history.length = 0;
    },
  };
}
