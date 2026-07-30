// FIXTURE — this file is expected to FAIL lint. Acceptance test A12 asserts that.
//
// A swallowed error in an ingestion path means data loss with no signal: the event is
// gone, no metric moved, no log line was written, and the dashboard looks healthy.

export function ingest(payload: unknown): void {
  try {
    JSON.stringify(payload);
  } catch {
    // Swallowed on purpose, to prove the rule fires.
  }
}

export function alsoSilent(payload: unknown): string {
  let result = '';
  try {
    result = JSON.stringify(payload);
  } catch (error) {
    result = '';
  }
  return result;
}
