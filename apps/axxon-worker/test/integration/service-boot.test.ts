import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Does the deployable worker artifact start, serve /health, and shut down cleanly?
 *
 * Same rationale as the engine's boot test: only building and running the bundle exercises
 * module resolution and the bind path, which no in-process test touches. It also verifies
 * the two Phase 4 realities end to end — the worker refuses a DATABASE_URL, and SIGTERM
 * exits 0 after draining.
 */

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const workerDir = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8393;

let child: ChildProcess | null = null;

afterEach(async () => {
  if (child !== null && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
  }
  child = null;
});

function baseEnv(port: number): Record<string, string> {
  return {
    ...process.env,
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    SERVICE_SECRET_CURRENT: 'boot-test-secret',
    SERVICE_SECRET_CURRENT_KID: 'k1',
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    RECONNECT_INITIAL_MS: '200',
    RECONNECT_MAX_MS: '1000',
    LOG_LEVEL: 'info',
    // Ensure no DB credential leaks from the ambient shell into the child.
    DATABASE_URL: '',
    DATABASE_URL_OWNER: '',
    ADMIN_DATABASE_URL: '',
  };
}

async function build(): Promise<void> {
  await execFileAsync('pnpm', ['--filter', '@deepsight/axxon-worker', 'build'], { cwd: repoRoot });
}

describe('the deployable worker artifact', () => {
  it('builds, boots, and answers /health', async () => {
    await build();
    const env = baseEnv(PORT);
    delete (env as Record<string, string | undefined>)['DATABASE_URL'];
    delete (env as Record<string, string | undefined>)['DATABASE_URL_OWNER'];
    delete (env as Record<string, string | undefined>)['ADMIN_DATABASE_URL'];

    const stdout: string[] = [];
    const stderr: string[] = [];
    child = spawn('node', ['dist/index.js'], {
      cwd: workerDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (c: Buffer) => stdout.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));

    const deadline = Date.now() + 30_000;
    let body: { status?: string; service?: string } | null = null;
    while (Date.now() < deadline && body === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.ok) body = (await res.json()) as { status: string; service: string };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (body === null) {
      throw new Error(
        `worker did not become healthy.\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`,
      );
    }
    expect(body.status).toBe('ok');
    expect(body.service).toBe('axxon-worker');
  }, 90_000);

  it('refuses to start when DATABASE_URL is set', async () => {
    await build();
    const env = baseEnv(PORT + 1);
    env['DATABASE_URL'] = 'postgres://should-not-be-here';

    const stderr: string[] = [];
    child = spawn('node', ['dist/index.js'], {
      cwd: workerDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));

    const exitCode = await new Promise<number | null>((resolve) => {
      child?.once('exit', (code) => resolve(code));
    });

    // Non-zero exit, and the message names DATABASE_URL — a DB credential must never be
    // silently accepted by this service.
    expect(exitCode).not.toBe(0);
    expect(stderr.join('')).toMatch(/DATABASE_URL/);
  }, 90_000);

  it('shuts down cleanly on SIGTERM', async () => {
    await build();
    const env = baseEnv(PORT + 2);
    delete (env as Record<string, string | undefined>)['DATABASE_URL'];
    delete (env as Record<string, string | undefined>)['DATABASE_URL_OWNER'];
    delete (env as Record<string, string | undefined>)['ADMIN_DATABASE_URL'];

    child = spawn('node', ['dist/index.js'], {
      cwd: workerDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not log startup')), 30_000);
      child?.stdout?.on('data', (c: Buffer) => {
        if (c.toString('utf8').includes('axxon worker listening')) {
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
    // Railway sends SIGTERM on redeploy; a clean drain-and-exit-0 is part of deploying.
    expect(exitCode).toBe(0);
  }, 90_000);
});
