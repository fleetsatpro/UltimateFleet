#!/usr/bin/env node
/**
 * Creates the three database roles. Requires superuser, runs once per database, and is
 * deliberately NOT a migration — migrations run as deepsight_owner, which this creates.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { adminUrl } from './lib/env.mjs';

const sqlPath = new URL('../bootstrap/bootstrap.sql', import.meta.url);
const sql = await readFile(sqlPath, 'utf8');

const client = new pg.Client({ connectionString: adminUrl() });
await client.connect();
try {
  await client.query(sql);
  console.log(
    'db:bootstrap OK — roles deepsight_owner / deepsight_app / deepsight_readonly ready.',
  );
} finally {
  await client.end();
}
