import { chromium, type Browser } from 'playwright';

/**
 * A bounded pool of Chromium browsers for PDF rendering.
 *
 * Rendering a report launches a browser, and a browser is ~100 MB of RSS — so a naive
 * "launch one per report" design melts under 20 concurrent report jobs. The pool caps the number
 * of LIVE browsers at `maxBrowsers` and reuses them: a render borrows a browser, opens a fresh
 * `newContext()` (an isolated, cookie-clean session — never a shared context, which would leak
 * one client's report state into another's), renders, and returns the browser. A browser is
 * recycled — closed and, if anyone is waiting, replaced — after `maxRendersPerBrowser` renders or
 * when process RSS crosses the ceiling, which is what bounds the long-run memory creep Chromium is
 * prone to. Acceptance criterion 1 asserts the cap (≤ N+1 processes for 20 jobs); criterion 4, the
 * recycling.
 */
export interface BrowserPoolOptions {
  readonly executablePath: string;
  readonly maxBrowsers: number;
  readonly maxRendersPerBrowser: number;
  readonly rssCeilingBytes?: number | undefined;
}

export interface PoolStats {
  readonly liveBrowsers: number;
  readonly totalLaunched: number;
  readonly totalRenders: number;
}

export interface BrowserPool {
  render(html: string): Promise<Buffer>;
  stats(): PoolStats;
  close(): Promise<void>;
}

interface Pooled {
  browser: Browser;
  renders: number;
}

export function createBrowserPool(options: BrowserPoolOptions): BrowserPool {
  const idle: Pooled[] = [];
  const waiters: Array<(p: Pooled) => void> = [];
  const rssCeiling = options.rssCeilingBytes ?? Number.POSITIVE_INFINITY;
  let live = 0;
  let totalLaunched = 0;
  let totalRenders = 0;
  let closed = false;

  // Reserving the slot is SYNCHRONOUS: `live` must be incremented before the first `await`, or 20
  // concurrent acquires all observe live=0 and each launches a browser — the pool's whole reason
  // to exist defeated by a race. The async launch happens only after the slot is claimed.
  async function openReservedBrowser(): Promise<Pooled> {
    try {
      // --no-sandbox: the render worker runs as an unprivileged container process where the
      // Chromium sandbox cannot initialise; isolation is the container's job, not the browser's.
      const browser = await chromium.launch({
        executablePath: options.executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      return { browser, renders: 0 };
    } catch (error) {
      // The launch failed, so give the reserved slot back.
      live -= 1;
      throw error;
    }
  }

  async function acquire(): Promise<Pooled> {
    const existing = idle.pop();
    if (existing !== undefined) return existing;
    if (live < options.maxBrowsers) {
      live += 1;
      totalLaunched += 1;
      return openReservedBrowser();
    }
    return new Promise<Pooled>((resolve) => waiters.push(resolve));
  }

  async function release(pooled: Pooled): Promise<void> {
    pooled.renders += 1;
    totalRenders += 1;
    const recycle =
      pooled.renders >= options.maxRendersPerBrowser || process.memoryUsage().rss > rssCeiling;

    if (recycle) {
      await pooled.browser.close();
      live -= 1;
      // Recycling frees a slot; if a render is waiting, launch a fresh browser for it so the cap
      // is respected without starving the queue. Reserve the slot synchronously, as in acquire.
      const waiter = waiters.shift();
      if (waiter !== undefined && !closed) {
        live += 1;
        totalLaunched += 1;
        waiter(await openReservedBrowser());
      }
      return;
    }

    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(pooled);
    else idle.push(pooled);
  }

  return {
    async render(html) {
      if (closed) throw new Error('browser pool is closed');
      const pooled = await acquire();
      try {
        const context = await pooled.browser.newContext();
        try {
          const page = await context.newPage();
          await page.setContent(html, { waitUntil: 'load' });
          return await page.pdf({ format: 'A4', printBackground: true });
        } finally {
          await context.close();
        }
      } finally {
        await release(pooled);
      }
    },

    stats() {
      return { liveBrowsers: live, totalLaunched, totalRenders };
    },

    async close() {
      closed = true;
      const all = idle.splice(0);
      for (const pooled of all) {
        await pooled.browser.close();
        live -= 1;
      }
    },
  };
}
