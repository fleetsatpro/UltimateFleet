// FIXTURE — this file is expected to FAIL lint. Acceptance test A12 asserts that.
// Excluded from the repo-wide lint run via the `ignores` entry in the shared config.
//
// Promise.all in a per-source fetch is exactly the bug the ban exists to prevent: one
// vendor being down would reject the whole aggregation, so a single failing source
// blocks report generation for every client instead of flagging one.

export async function fetchAllSources(
  sources: readonly (() => Promise<string>)[],
): Promise<string[]> {
  return Promise.all(sources.map((fetch) => fetch()));
}
