/**
 * Schema guards — the mechanical form of two brief non-negotiables.
 *
 * These interrogate the *live catalog* rather than regexing migration SQL. That
 * matters: a migration whose text mentions FORCE ROW LEVEL SECURITY but whose
 * DO-block never reaches a table would pass a text scan and still ship a
 * cross-tenant leak. The catalog is the end state, and cannot be fooled.
 *
 * Guard 1 (tenancy): every tenant-scoped table has org_id, RLS enabled, RLS
 *   forced, and at least one permissive policy. Under D6 a tenant table shipped
 *   without RLS is a silent cross-operator data leak — exactly the omission that
 *   survives code review because the table looks fine in isolation.
 *
 * Guard 2 (binary): no bytea/blob column outside a named allowlist. This turns
 *   divergence D5's scoped exception into an enforced boundary, so a developer
 *   adding `photo bytea` fails CI with a message pointing at the R2 rule.
 */

/** Tables that are deliberately global config, not tenant-scoped. */
export const GLOBAL_TABLES = new Set([
  'alarm_event_type_mappings',
  // node-pg-migrate's own bookkeeping table.
  'pgmigrations',
]);

/**
 * The only binary column permitted anywhere in the system (divergence D5): a
 * fixed-size, non-reversible face embedding. It lives in PostgreSQL rather than
 * R2 because it needs RLS, transactional revocation, and a transactional delete
 * for right-to-erasure. Everything variable-size goes to R2.
 */
export const BINARY_COLUMN_ALLOWLIST = new Set(['guard_enrollments.embedding_vector']);

async function userTables(client) {
  const { rows } = await client.query(`
    SELECT c.relname             AS table_name,
           c.relrowsecurity      AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     ORDER BY c.relname
  `);
  return rows;
}

/** @returns {Promise<string[]>} human-readable violations; empty means clean. */
export async function findTenancyViolations(client) {
  const violations = [];
  const tables = await userTables(client);

  const { rows: orgColumns } = await client.query(`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'org_id'
  `);
  const hasOrgId = new Set(orgColumns.map((r) => r.table_name));

  const { rows: policies } = await client.query(`
    SELECT tablename, policyname, permissive FROM pg_policies WHERE schemaname = 'public'
  `);
  const permissiveByTable = new Map();
  for (const p of policies) {
    const list = permissiveByTable.get(p.tablename) ?? [];
    list.push(p);
    permissiveByTable.set(p.tablename, list);
  }

  for (const t of tables) {
    if (GLOBAL_TABLES.has(t.table_name)) continue;

    // `organizations` is the tenant root: it is scoped by its own id, not by org_id.
    const isTenantRoot = t.table_name === 'organizations';

    if (!isTenantRoot && !hasOrgId.has(t.table_name)) {
      violations.push(
        `${t.table_name}: tenant-scoped table has no org_id column. ` +
          `Add one, or add the table to GLOBAL_TABLES if it is genuinely global config.`,
      );
    }
    if (!t.rls_enabled) {
      violations.push(`${t.table_name}: ROW LEVEL SECURITY is not enabled.`);
    }
    if (!t.rls_forced) {
      violations.push(
        `${t.table_name}: ROW LEVEL SECURITY is not FORCED. Without FORCE, the table ` +
          `owner bypasses every policy — the most commonly missed step in production RLS.`,
      );
    }

    const tablePolicies = permissiveByTable.get(t.table_name) ?? [];
    const permissive = tablePolicies.filter((p) => p.permissive === 'PERMISSIVE');
    if (tablePolicies.length === 0) {
      violations.push(
        `${t.table_name}: RLS is on but no policy exists — the table returns no rows.`,
      );
    } else if (permissive.length === 0) {
      // Verified experimentally: restrictive-only policies yield zero rows, because
      // PostgreSQL computes (OR of permissive) AND (AND of restrictive), and an empty
      // permissive set is false. This is a total blackout, not isolation.
      violations.push(
        `${t.table_name}: has only RESTRICTIVE policies. PostgreSQL requires at least one ` +
          `PERMISSIVE policy to grant access; restrictive policies only subtract.`,
      );
    }
  }

  return violations;
}

/** @returns {Promise<string[]>} human-readable violations; empty means clean. */
export async function findBinaryColumnViolations(client) {
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('bytea')
     ORDER BY table_name, column_name
  `);

  return rows
    .filter((r) => !BINARY_COLUMN_ALLOWLIST.has(`${r.table_name}.${r.column_name}`))
    .map(
      (r) =>
        `${r.table_name}.${r.column_name} is ${r.data_type}. Binary data must never be stored ` +
        `in PostgreSQL — stream it to Cloudflare R2 and store the object key instead. ` +
        `If this is fixed-size credential material, add it to BINARY_COLUMN_ALLOWLIST with a reason.`,
    );
}

export async function runAllGuards(client) {
  // Sequential deliberately: two cheap catalog queries, and Promise.all is banned
  // repo-wide by the lint rule this very file is subject to.
  const tenancy = await findTenancyViolations(client);
  const binary = await findBinaryColumnViolations(client);
  return [...tenancy, ...binary];
}
