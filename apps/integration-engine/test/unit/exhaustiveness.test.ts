import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2 acceptance criterion 5: adding a fourth IngestionMode fails typecheck until the
 * dispatcher handles it.
 *
 * Asserted by actually running tsc, because this is a compile-time property and no runtime
 * assertion can observe it. Two fixtures, not one: a passing counterpart proves tsc is
 * genuinely working, so the failing case is failing for the intended reason rather than
 * because of a broken config.
 */

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface TscResult {
  readonly exitCode: number;
  readonly output: string;
}

async function typecheckFixture(fixture: string): Promise<TscResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--exactOptionalPropertyTypes',
        '--noUncheckedIndexedAccess',
        '--target',
        'ES2023',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        // Mirrors tsconfig.base.json. Without it, third-party .d.ts files (@types/node
        // reaching for undici-types) fail under these strict settings and the fixture's
        // own correctness gets lost in unrelated library noise.
        '--skipLibCheck',
        `tests/fixtures/exhaustiveness/${fixture}`,
      ],
      { cwd: repoRoot },
    );
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.code ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('AC5 — exhaustiveness over IngestionMode is compiler-enforced', () => {
  it('fails to compile when a fourth mode is unhandled', async () => {
    const result = await typecheckFixture('added-mode.ts');

    expect(result.exitCode).not.toBe(0);
    // TS2322 on the `const exhaustive: never = adapter` line. Asserting the specific error
    // matters: any old compile failure would satisfy a bare non-zero-exit check.
    expect(result.output).toMatch(/TS2322/);
    expect(result.output).toMatch(/not assignable to type 'never'/);
    expect(result.output).toMatch(/BatchFileAdapter/);
  }, 60_000);

  it('compiles cleanly when every mode is handled', async () => {
    const result = await typecheckFixture('all-modes-handled.ts');

    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
