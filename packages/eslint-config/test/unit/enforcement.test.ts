import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

/**
 * Phase 1 acceptance test A12 (lint half): the coding standards are mechanically
 * enforced, not aspirational.
 *
 * Each fixture is a mistake a future developer will plausibly make. If any of these
 * stops failing, a brief non-negotiable has silently become a suggestion — which is
 * exactly the failure mode that makes standards documents worthless.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

async function lintFixture(relativePath: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({
    cwd: repoRoot,
    // Fixtures are in the shared config's `ignores` so they do not fail the normal
    // repo-wide run; here they are linted deliberately.
    ignore: false,
  });
  const results = await eslint.lintFiles([`tests/fixtures/${relativePath}`]);
  const result = results[0];
  if (result === undefined) throw new Error(`No lint result for fixture ${relativePath}`);
  return result;
}

describe('A12 — enforcement rules fire on real violations', () => {
  it('rejects Promise.all with a message pointing at Promise.allSettled', async () => {
    const result = await lintFixture('banned-promise-all.ts');

    expect(result.errorCount).toBeGreaterThan(0);
    const messages = result.messages.map((m) => m.message).join('\n');
    expect(messages).toMatch(/Promise\.all is banned/);
    expect(messages).toMatch(/allSettled/);
  });

  it('rejects a silently swallowed error', async () => {
    const result = await lintFixture('silent-catch.ts');

    expect(result.errorCount).toBeGreaterThan(0);
    const ruleIds = result.messages.map((m) => m.ruleId);
    expect(
      ruleIds.some((id) => id === 'deepsight/no-silent-catch' || id === 'no-empty'),
      `expected a silent-catch violation, got: ${ruleIds.join(', ')}`,
    ).toBe(true);
  });

  it('reports both silent catches in the fixture, not just the empty one', async () => {
    const result = await lintFixture('silent-catch.ts');
    const silentCatchErrors = result.messages.filter(
      (m) => m.ruleId === 'deepsight/no-silent-catch',
    );
    // One empty catch, one that assigns without logging or rethrowing.
    expect(silentCatchErrors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('A12 — the rules do not fire on compliant code', () => {
  it('accepts Promise.allSettled and a catch that logs and rethrows', async () => {
    const eslint = new ESLint({ cwd: repoRoot, ignore: false });
    const results = await eslint.lintText(
      `export async function ok(sources: readonly (() => Promise<string>)[]) {
  const settled = await Promise.allSettled(sources.map((f) => f()));
  try {
    return settled.filter((s) => s.status === 'fulfilled');
  } catch (error) {
    console.error({ context: 'ok', error });
    throw error;
  }
}
`,
      { filePath: 'packages/contracts/src/compliant-probe.ts' },
    );

    const result = results[0];
    if (result === undefined) throw new Error('No lint result');
    // A false positive here would make the rules unusable and pressure the team into
    // disabling them, so this assertion matters as much as the ones above.
    expect(
      result.messages.filter(
        (m) => m.ruleId === 'deepsight/no-silent-catch' || m.ruleId === 'no-restricted-syntax',
      ),
    ).toEqual([]);
  });
});
