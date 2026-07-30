#!/usr/bin/env node
/**
 * Enforces the two apps/ vs packages/ invariants from
 * docs/architecture/02-REPOSITORY-STRUCTURE.md section 1:
 *
 *   1. Nothing in packages/ has a `start` script. If it can be started, it is an app.
 *   2. Nothing in apps/ is imported by another workspace member. If it is imported,
 *      it is a package.
 *
 * Violating either produces the classic monorepo failure where a "shared library"
 * quietly acquires a server and two deployment targets begin sharing process state.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function readWorkspace(kind) {
  const dir = join(root, kind);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    out.push({
      kind,
      dir: entry.name,
      manifestPath,
      manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    });
  }
  return out;
}

const apps = await readWorkspace('apps');
const packages = await readWorkspace('packages');
const violations = [];

// Invariant 1: no start script in packages/
for (const pkg of packages) {
  if (pkg.manifest.scripts?.start !== undefined) {
    violations.push(
      `packages/${pkg.dir} defines a "start" script. If it can be started it belongs in apps/.`,
    );
  }
}

// Invariant 2: no workspace member depends on an app
const appNames = new Set(apps.map((a) => a.manifest.name));
for (const member of [...apps, ...packages]) {
  const deps = {
    ...member.manifest.dependencies,
    ...member.manifest.devDependencies,
    ...member.manifest.peerDependencies,
  };
  for (const dep of Object.keys(deps)) {
    if (appNames.has(dep) && dep !== member.manifest.name) {
      violations.push(
        `${member.kind}/${member.dir} depends on "${dep}", which is an app. ` +
          `If it is imported it belongs in packages/.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('apps/ vs packages/ boundary violations:\n');
  for (const v of violations) console.error(`  - ${v}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check:boundaries OK — ${apps.length} app(s), ${packages.length} package(s), no violations.`,
);
