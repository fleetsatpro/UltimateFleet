#!/usr/bin/env node
import pg from 'pg';
import { seedAll } from '../seeds/seed.mjs';
import { ownerUrl } from './lib/env.mjs';

const client = new pg.Client({ connectionString: ownerUrl() });
await client.connect();
try {
  await seedAll(client);
  console.log('db:seed OK — 2 organizations x 2 clients seeded.');
} finally {
  await client.end();
}
