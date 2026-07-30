/**
 * A stable, comparable fingerprint of the live schema.
 *
 * Deliberately a library module with no top-level side effects, so tests can import it
 * without triggering a migration run. (It began life inside migrate-down-up.mjs, whose
 * top-level `await main()` meant importing the helper silently executed a full
 * down/up cycle — an invisible side effect of an import.)
 *
 * Covers columns, policies including their USING and WITH CHECK expressions, RLS flags,
 * and every index definition. So a down() that drops a table but forgets its policy, or
 * an up() that recreates a table without its partial index, both show up as a diff.
 */
export async function schemaSnapshot(client) {
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, column_name
  `);
  const { rows: policies } = await client.query(`
    SELECT tablename, policyname, permissive, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'
     ORDER BY tablename, policyname
  `);
  const { rows: rls } = await client.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `);
  const { rows: indexes } = await client.query(`
    SELECT tablename, indexname, indexdef
      FROM pg_indexes WHERE schemaname = 'public'
     ORDER BY tablename, indexname
  `);
  const { rows: routines } = await client.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY p.proname
  `);
  return JSON.stringify({ columns, policies, rls, indexes, routines }, null, 2);
}
