import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  newCorrelationId,
  withCorrelation,
  type Alerts,
  type Logger,
  type Metrics,
} from '@deepsight/observability';
import type { MappingCache } from '../ingestion/mapping-cache.js';
import type { WebhookHandler } from './webhook.js';

/** Per-vendor status the dashboard reads from /health. Populated from adapter health. */
export interface VendorHealth {
  readonly vendor: string;
  readonly status: 'connected' | 'degraded' | 'offline';
  readonly breaker_state: 'closed' | 'open' | 'half-open';
  readonly error?: string | undefined;
}

export interface VendorHealthSource {
  snapshot(): Promise<readonly VendorHealth[]>;
}

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
  /**
   * Interim bearer token guarding /admin routes until Phase 7 replaces it with supervisor
   * sessions and RBAC. Absent means the routes refuse to serve at all — see requireAdmin.
   */
  readonly adminToken?: string | undefined;
  /** Inbound vendor webhooks (Dahua today). Absent -> the webhook route is not mounted. */
  readonly webhooks?: WebhookHandler | undefined;
  /** Per-vendor adapter health for /health. Absent -> vendors reported as []. */
  readonly vendorHealth?: VendorHealthSource | undefined;
}

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Guards mutating /admin routes.
 *
 * Fails CLOSED when no token is configured: an unauthenticated endpoint that can change how
 * every incoming alarm is classified is not an acceptable default, and "we'll add auth in
 * Phase 7" must not mean "it is open until then". A missing token is a 503, not a bypass.
 *
 * Constant-time comparison so the token cannot be recovered a byte at a time.
 */
function requireAdmin(deps: AppDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = deps.adminToken;
    if (expected === undefined || expected === '') {
      deps.logger.warn(
        { path: req.path },
        'admin route refused: ADMIN_API_TOKEN is not configured',
      );
      res.status(503).json({
        error: 'admin routes are disabled: ADMIN_API_TOKEN is not configured',
      });
      return;
    }

    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected, 'utf8');
    const presentedBytes = Buffer.from(presented, 'utf8');

    const ok =
      expectedBytes.length === presentedBytes.length &&
      timingSafeEqual(expectedBytes, presentedBytes);

    if (!ok) {
      deps.metrics.counter('admin_unauthorized_total', 1, { path: req.path });
      deps.logger.warn({ path: req.path }, 'admin route rejected: bad or missing bearer token');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}

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

  app.get('/health', async (_req: Request, res: Response) => {
    // Per-vendor status and circuit-breaker state is what the dashboard uses to show a
    // vendor as connected / degraded / offline (brief section 6). Failing to gather it must
    // not fail the health check itself — a broken vendor is not a broken engine.
    let vendors: readonly VendorHealth[] = [];
    try {
      vendors = (await deps.vendorHealth?.snapshot()) ?? [];
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.message : error },
        'vendor health snapshot failed',
      );
      vendors = [];
    }

    res.json({
      status: 'ok',
      service: 'integration-engine',
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      mappings: {
        count: deps.mappings.size(),
        loadedAt: deps.mappings.loadedAt()?.toISOString() ?? null,
      },
      vendors,
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
   * Guarded by requireAdmin: a bearer token now, supervisor sessions and RBAC from Phase 7.
   */
  app.post('/admin/mappings/reload', requireAdmin(deps), async (_req: Request, res: Response) => {
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

  /**
   * Vendor webhook ingress.
   *
   * Mounted with `express.raw` matching every content type, NOT `express.json`. This is the
   * whole point of divergence D4: HMAC is computed over the exact received bytes, and
   * `express.json` would consume and discard them, making verification impossible. req.body
   * is a Buffer here. A regression test asserts a json-mounted variant fails verification.
   */
  if (deps.webhooks !== undefined) {
    const webhooks = deps.webhooks;
    app.post(
      '/webhooks/:vendor',
      express.raw({ type: '*/*', limit: '2mb' }),
      async (req: Request, res: Response) => {
        const rawBody: Uint8Array = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }
        const vendor = req.params.vendor ?? '';
        const result = await webhooks.handle(vendor, rawBody, headers);
        res.status(result.status).json(result.body);
      },
    );
  }

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
