#!/usr/bin/env node
/**
 * Repo-wide secret scan (Phase 7, acceptance criterion 1: "no token value appears anywhere in
 * the source tree").
 *
 * Enrollment tokens, refresh tokens and session ids are ALL generated at runtime from a CSPRNG
 * and returned to the caller once — none is ever hardcoded. This scan enforces that by hunting
 * the source for high-entropy literals that look like a committed token or secret: a quoted
 * string of 40+ characters drawn only from the base64url/hex alphabet (no spaces, no dots, not a
 * UUID). A 32-byte token is ~43 such characters, so a hardcoded one is caught; ordinary
 * identifiers, messages and short test fixtures are not.
 *
 * It scans src AND test: a token pasted into a test is just as much a leak as one in product
 * code. If a genuine high-entropy constant must exist, add its exact value to ALLOWLIST with a
 * reason rather than weakening the pattern.
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ROOTS = ['packages', 'apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

// High-entropy literal: 40+ base64url/hex chars, nothing else. UUIDs (with dashes) are excluded
// by the character class disallowing '-' adjacent... actually base64url allows '-' and '_', so
// UUIDs are excluded separately below.
const LITERAL = /['"`]([A-Za-z0-9_-]{40,})['"`]/g;
const UUID = /^[0-9a-f-]{36}$/i;

/** Known-safe high-entropy strings, if any ever arise. Empty by design. */
const ALLOWLIST = new Set([]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const findings = [];
for (const top of ROOTS) {
  for (const file of walk(join(root, top))) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(LITERAL)) {
        const value = match[1];
        if (UUID.test(value) || ALLOWLIST.has(value)) continue;
        // Require some entropy: both letters and digits, so a long all-letter identifier or a
        // run of hyphens does not trip it.
        if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) continue;
        findings.push(
          `${relative(root, file)}:${i + 1}  possible hardcoded secret: ${value.slice(0, 12)}…`,
        );
      }
    });
  }
}

if (findings.length > 0) {
  console.error('scan-secrets FAILED — high-entropy literals that look like committed tokens:\n');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('\nTokens must be generated at runtime, never hardcoded. If a value is genuinely');
  console.error('safe, add it to ALLOWLIST in scripts/scan-secrets.mjs with a reason.');
  process.exitCode = 1;
} else {
  console.log('scan-secrets OK — no hardcoded token or secret literals in the source tree.');
}
