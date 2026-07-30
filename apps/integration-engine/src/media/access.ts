import { getIncidentMedia, withOrg } from '@deepsight/db';
import type { ObjectStore } from '@deepsight/storage-r2';

/**
 * Signed-URL issuance for dashboard access to incident media.
 *
 * The bytes live in R2, which has no row-level authorization of its own, so access control is
 * the URL's finite lifetime plus this gate: a URL is issued ONLY for a row that is actually
 * `stored`. A pending or failed row yields null — the dashboard shows "no media" rather than a
 * link that 404s or, worse, a stale key. The lookup runs under the tenant's org, so RLS makes
 * cross-tenant media unreachable here even before the key is signed.
 *
 * Phase 6 mounts this behind the dashboard's authenticated route; Phase 5 delivers the issuance
 * itself and proves its expiry semantics against the object store.
 */
export interface MediaUrlIssuerDeps {
  readonly objectStore: ObjectStore;
  readonly ttlSeconds: number;
}

export interface MediaUrlIssuer {
  /** A time-limited GET URL for a stored media row, or null if it is not stored. */
  presignStored(orgId: string, mediaId: string): Promise<string | null>;
}

export function createMediaUrlIssuer(deps: MediaUrlIssuerDeps): MediaUrlIssuer {
  return {
    async presignStored(orgId, mediaId) {
      const row = await withOrg(orgId, (tx) => getIncidentMedia(tx, mediaId));
      if (row === null || row.status !== 'stored' || row.r2_object_key === null) {
        return null;
      }
      return deps.objectStore.presignGet(row.r2_object_key, deps.ttlSeconds);
    },
  };
}
