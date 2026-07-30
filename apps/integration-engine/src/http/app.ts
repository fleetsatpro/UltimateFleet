import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  newCorrelationId,
  withCorrelation,
  type Alerts,
  type Logger,
  type Metrics,
} from '@deepsight/observability';
import type { MappingCache } from '../ingestion/mapping-cache.js';

/**
 * The HTTP surface, built as a factory so tests can exercise it without binding a port.
 *
 * Phase 2 exposes health and the mapping-reload endpoint. Vendor webhook routes arrive in
 * Phase 3, mounted with express.raw() rather than express.json() — under express.json()
 * the raw bytes are consumed and discarded, and HMAC verification becomes impossible
 * (divergence D4).
 */

export interface AppDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly alerts: Alerts;
  readonly mappings: MappingCache;
  readonly startedAt: Date;
}

const CORRELATION_HEADER = 'x-correlation-id';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  /**
   * Establishes the correlation context for the whole request.
   *
   * An inbound id is honoured so a trace begun by a caller continues rather than
   * restarting; otherwise one is minted here. Everything downstream — normalization,
   * persistence, fan-out — reads it from AsyncLocalStorage, so no call site can forget
   * to pass it along.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header(CORRELATION_HEADER);
    const correlationId =
      inbound !== undefined && inbound.trim() !== '' ? inbound.trim() : newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);

    withCorrelation({ correlationId }, () => {
      const started = Date.now();
      res.on('finish', () => {
        deps.metrics.histogram('http_request_duration_ms', Date.now() - started, {
          method: req.method,
          status: String(res.statusCode),
        });
      });
      deps.logger.info({ method: req.method, path: req.path }, 'http request received');
      next();
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    // Vendor adapter health and per-vendor circuit breaker state join this payload in
    // Phase 3; the shape is stable so the dashboard can consume it from Phase 6.
    res.json({
      status: 'ok',
      service: 'integration-engine',
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      mappings: {
        count: deps.mappings.size(),
        loadedAt: deps.mappings.loadedAt()?.toISOString() ?? null,
      },
      vendors: [],
    });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    res.json({ samples: deps.metrics.snapshot() });
  });

  /**
   * Reloads the mapping table without restarting the process.
   *
   * The point of the whole DB-backed mapping design: a supervisor adds a row for a newly
   * observed vendor code and the next event is classified correctly, with no redeploy.
   * Returns the process pid so the acceptance test can prove no restart occurred.
   *
   * Authentication arrives in Phase 7 (supervisor RBAC); until then this route must not
   * be exposed publicly. Recorded in the phase plan rather than left implicit.
   */
  app.post('/admin/mappings/reload', async (_req: Request, res: Response) => {
    try {
      const count = await deps.mappings.reload();
      deps.metrics.counter('mapping_reload_total', 1);
      res.json({ reloaded: count, pid: process.pid });
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : error },
        'mapping reload failed',
      );
      deps.alerts.fire('mapping_reload_failed', {
        severity: 'warning',
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'mapping reload failed' });
    }
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // Express 4 identifies an error handler by its four-parameter signature, so `_next`
  // must stay even though it is unused.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err: error.message }, 'unhandled request error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
