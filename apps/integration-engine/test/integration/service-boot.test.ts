import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { appDatabaseUrl } from '@deepsight/test-support';

/**
 * Does the service actually start?
 *
 * This test exists because it did not. Everything else in the suite exercises the app graph
 * in-process, which never touches the module resolution the real entrypoint depends on — so
 * the whole of Phase 2 shipped with a `start` command that failed immediately:
 * NodeNext requires `.js` import specifiers, the files on disk are `.ts`, and Node's type
 * stripping does not remap the extension. `ERR_MODULE_NOT_FOUND` on the first import.
 *
 * The only way to catch that class of bug is to build the deployable artifact and run it, so
 * that is what this does: build, spawn, poll /health, shut down.
 */

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const engineDir = fileURLToPath(new URL('../../', import.meta.url));

// A high, fixed port rather than 0: the child must be told its port up front, and the
// integration suite runs serially so there is no contention.
const PORT = 8391;

let child: ChildProcess | null = null;

afterEach(async () => {
  if (child !== null && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child?.once('exit', resolve);
      setTimeout(resolve, 5_000);
    });
  }
  child = null;
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForHealth(timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return response;
      lastError = `status ${response.status}`;
    } catch (error) {
      // The connection is refused until the child has bound its port; recording the
      // reason (rather than swallowing it) is what makes a real boot failure legible
      // instead of just "did not become healthy".
      lastError = describeError(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Service did not become healthy within ${timeoutMs}ms: ${lastError}`);
}

describe('the deployable artifact starts and serves traffic', () => {
  it('builds, boots, and answers /health', async () => {
    // esbuild takes ~150ms, so building here rather than assuming a prior step keeps the
    // test self-contained and still catches a broken build.
    await execFileAsync('pnpm', ['--filter', '@deepsight/integration-engine', 'build'], {
      cwd: repoRoot,
    });

    const stderr: string[] = [];
    const stdout: string[] = [];

    child = spawn('node', ['dist/index.js'], {
      cwd: engineDir,
      env: {
        ...process.env,
        DATABASE_URL: appDatabaseUrl(),
        REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
        SERVICE_SECRET_CURRENT: 'boot-test-secret',
        SERVICE_SECRET_CURRENT_KID: 'k1',
        PORT: String(PORT),
        // 127.0.0.1 rather than the production default of `::`: Railway private networking
        // needs the IPv6 wildcard, but CI runners and containers are frequently IPv4-only
        // and would fail with EAFNOSUPPORT.
        BIND_HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

    const response = await waitForHealth(30_000).catch((error: unknown) => {
      throw new Error(
        `${String(error)}\n--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}`,
      );
    });

    const body = (await response.json()) as {
      status: string;
      service: string;
      mappings: { count: number };
    };

    expect(body.status).toBe('ok');
    expect(body.service).toBe('integration-engine');
    expect(body.mappings.count).toBeGreaterThan(0);

    // Startup must be structured JSON on stdout — that is what Railway's log drain consumes.
    const startupLines = stdout
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(startupLines.some((line) => line['msg'] === 'integration engine listening')).toBe(true);
    for (const line of startupLines) expect(line['service']).toBe('integration-engine');

    // Nothing should reach stderr on a clean boot; an unhandled event or a raw stack trace
    // there is exactly the symptom this test was written after.
    expect(stderr.join('')).toBe('');
  }, 90_000);

  it('shuts down cleanly on SIGTERM', async () => {
    await execFileAsync('pnpm', ['--filter', '@deepsight/integration-engine', 'build'], {
      cwd: repoRoot,
    });

    child = spawn('node', ['dist/index.js'], {
      cwd: engineDir,
      env: {
        ...process.env,
        DATABASE_URL: appDatabaseUrl(),
        REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
        SERVICE_SECRET_CURRENT: 'boot-test-secret',
        SERVICE_SECRET_CURRENT_KID: 'k1',
        PORT: String(PORT + 1),
        BIND_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('service did not log startup')), 30_000);
      child?.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('integration engine listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await started;

    const exitCode = await new Promise<number | null>((resolve) => {
      child?.once('exit', (code) => resolve(code));
      child?.kill('SIGTERM');
    });

    // Railway sends SIGTERM on every redeploy. A non-zero exit there is reported as a crash
    // loop, so draining and exiting 0 is part of deploying cleanly.
    expect(exitCode).toBe(0);
  }, 90_000);
});
