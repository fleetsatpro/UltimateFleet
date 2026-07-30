#!/usr/bin/env node
import { migrate } from './lib/migrate.mjs';

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const applied = await migrate(direction, undefined);
console.log(`db:migrate ${direction} OK — ${applied?.length ?? 0} migration(s) applied.`);
