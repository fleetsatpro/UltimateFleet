import type { PollCursor } from '@deepsight/contracts';
import { readPollCursor, withOrg, writePollCursor } from '@deepsight/db';

/**
 * Identifies a pollable source. The org id travels with it because every query path is
 * tenant-scoped — there is no ambient "current org", so a source reference that omits it
 * simply cannot be read.
 */
export interface PollSource {
  readonly orgId: string;
  readonly sourceId: string;
}

export interface CursorStore {
  read(source: PollSource): Promise<PollCursor>;
  write(source: PollSource, cursor: PollCursor): Promise<void>;
}

/**
 * Database-backed cursor store.
 *
 * The cursor is opaque to the core — only the adapter knows what its string means — so it
 * is stored as text and handed straight back. Persisting it means polling resumes across
 * a redeploy instead of re-fetching all history or silently skipping whatever arrived
 * while the process was restarting.
 */
export function createCursorStore(): CursorStore {
  return {
    async read(source) {
      const value = await withOrg(source.orgId, (tx) => readPollCursor(tx, source.sourceId));
      return value === null ? null : { value };
    },

    async write(source, cursor) {
      const written = await withOrg(source.orgId, (tx) =>
        writePollCursor(tx, source.sourceId, cursor === null ? null : cursor.value),
      );
      if (!written) {
        // A missing source row means the poll scheduler is driving a source that has been
        // deleted or belongs to another org. Silently succeeding would let polling
        // continue forever against a source nobody can see.
        throw new Error(
          `Cannot persist poll cursor: alarm source ${source.sourceId} not found in org ${source.orgId}`,
        );
      }
    },
  };
}
