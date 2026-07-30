import {
  ALARM_EVENTS_PER_CLIENT,
  ATTENDANCE_PER_GUARD,
  ORGS,
  PATROL_SCANS_PER_GUARD,
} from './fixtures.mjs';

/**
 * Seeds deterministic integration fixtures.
 *
 * Runs as deepsight_owner, which is subject to FORCE ROW LEVEL SECURITY — so the seed
 * must set app.current_org_id for each organization before writing its rows. That is
 * not a workaround: it means the seed itself exercises the policies, and a broken
 * WITH CHECK clause fails here rather than silently in production.
 *
 * Idempotent via fixed ids + ON CONFLICT DO NOTHING, so re-running is a no-op.
 */

const BASE_TIME = Date.parse('2026-06-01T08:00:00Z');
const hoursAfterBase = (h) => new Date(BASE_TIME + h * 3_600_000);

async function setOrgContext(client, orgId) {
  // Session-scoped here, not transaction-local: the seed owns this dedicated
  // connection for its whole lifetime and re-sets the GUC per org. Application code
  // uses the transaction-local form — see packages/db/src/tenant.ts.
  await client.query('SELECT set_config($1, $2, false)', ['app.current_org_id', orgId]);
}

async function seedOrg(client, org) {
  await setOrgContext(client, org.id);

  await client.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
    [org.id, org.name, org.slug],
  );

  for (const c of org.clients) {
    await client.query(
      `INSERT INTO clients (id, org_id, name, contact_email) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
      [c.id, org.id, c.name, `reports+${c.name.toLowerCase().replace(/\s+/g, '-')}@example.test`],
    );
    for (const [index, siteId] of c.sites.entries()) {
      await client.query(
        `INSERT INTO sites (id, org_id, client_id, name, latitude, longitude, geofence_radius_m)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [siteId, org.id, c.id, `${c.name} Site ${index + 1}`, -1.2921, 36.8219, 100],
      );
    }
  }

  for (const g of org.guards) {
    await client.query(
      `INSERT INTO guards (id, org_id, full_name, employee_code) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
      [g.id, org.id, g.name, g.code],
    );
  }

  for (const u of org.users) {
    await client.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, client_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      // Not a real hash and never used to authenticate: Argon2id arrives in Phase 7.
      [u.id, org.id, u.email, 'seed-not-a-real-hash', u.role, u.clientId],
    );
  }

  const enroller = org.users[0];
  for (const e of org.enrollments) {
    await client.query(
      `INSERT INTO guard_enrollments (
         id, org_id, client_id, guard_id, device_id, embedding_vector,
         face_match_sdk, sdk_version, enrolled_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [
        e.id,
        org.id,
        e.clientId,
        e.guardId,
        e.deviceId,
        // A 2 KB placeholder standing in for a 512-float32 embedding. Fixed-size
        // credential material, the single permitted binary column (divergence D5).
        Buffer.alloc(2048, 7),
        'seed-sdk',
        '0.0.0-seed',
        enroller.id,
      ],
    );
  }

  await client.query(
    `INSERT INTO patrol_checkpoints (id, org_id, client_id, site_id, label, nfc_tag_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      org.checkpoint.id,
      org.id,
      org.checkpoint.clientId,
      org.checkpoint.siteId,
      'Main Gate',
      `nfc-${org.slug}-001`,
    ],
  );

  await client.query(
    `INSERT INTO alarm_sources (id, org_id, client_id, site_id, vendor, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      org.source.id,
      org.id,
      org.source.clientId,
      org.source.siteId,
      org.source.vendor,
      `${org.slug}-source-1`,
    ],
  );

  // Alarm events for every client, so client narrowing has something to narrow.
  let eventCounter = 0;
  /** @type {{internalId: string, clientId: string, siteId: string, closed: boolean}[]} */
  const seededEvents = [];
  for (const c of org.clients) {
    const siteId = c.sites[0];
    if (siteId === undefined) continue;
    for (let i = 0; i < ALARM_EVENTS_PER_CLIENT; i += 1) {
      eventCounter += 1;
      const internalId = `${org.id.slice(0, 8)}-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`;
      seededEvents.push({ internalId, clientId: c.id, siteId, closed: i % 2 !== 0 });
      await client.query(
        `INSERT INTO alarm_events (
           internal_id, org_id, client_id, site_id, vendor, vendor_event_id, vendor_event_code,
           event_type, severity, occurred_at, raw_payload, correlation_id, closed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [
          internalId,
          org.id,
          c.id,
          siteId,
          org.source.vendor,
          `${org.slug}-${c.id.slice(-4)}-evt-${i}`,
          '1001',
          i % 2 === 0 ? 'intrusion' : 'motion',
          i % 2 === 0 ? 'high' : 'low',
          hoursAfterBase(i),
          JSON.stringify({ marker: org.marker, client: c.name, seq: i }),
          `seed-correlation-${org.slug}-${i}`,
          // Half closed, half open, so the partial open-alarms index is exercised.
          i % 2 === 0 ? null : hoursAfterBase(i + 1),
        ],
      );
    }
  }

  // Closures for every event whose closed_at is set. A closure is an INSERTED ROW, not
  // an UPDATE on alarm_events: closures are immutable events, and alarm_events.closed_at
  // is a derived column serving the partial open-alarms index (architecture 11.3).
  for (const event of seededEvents.filter((e) => e.closed)) {
    await client.query(
      `INSERT INTO alarm_closures (
         org_id, client_id, alarm_event_id, closed_by_user_id, notes, occurred_at, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        org.id,
        event.clientId,
        event.internalId,
        enroller.id,
        'Seeded closure: verified on site, no action required.',
        hoursAfterBase(2),
        `seed-correlation-closure-${event.internalId.slice(-4)}`,
      ],
    );
  }

  // Incident media rows. The bytes live in R2 — these hold only the object key, and the
  // schema guard fails CI if anyone ever adds a binary column here.
  for (const [index, event] of seededEvents.slice(0, 2).entries()) {
    await client.query(
      `INSERT INTO incident_media (
         org_id, client_id, alarm_event_id, source_url, kind, r2_object_key, status, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        org.id,
        event.clientId,
        event.internalId,
        `https://vendor.example.test/media/${event.internalId}.jpg?expires=soon`,
        'image',
        index === 0 ? `incidents/${org.slug}/${event.internalId}.jpg` : null,
        index === 0 ? 'stored' : 'pending',
        hoursAfterBase(index === 0 ? 1 : 0),
      ],
    );
  }

  // Attendance and patrol history for each guard: test A10 asserts these survive
  // biometric erasure untouched.
  for (const g of org.guards) {
    const firstClient = org.clients[0];
    const siteId = firstClient?.sites[0];
    if (firstClient === undefined || siteId === undefined) continue;

    for (let i = 0; i < ATTENDANCE_PER_GUARD; i += 1) {
      await client.query(
        `INSERT INTO shift_attendance (
           org_id, client_id, site_id, guard_id, device_id, client_event_id,
           event_type, occurred_at, gps_latitude, gps_longitude, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          org.id,
          firstClient.id,
          siteId,
          g.id,
          `device-${g.code}`,
          `${g.id.slice(0, 8)}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          i % 2 === 0 ? 'sign_in' : 'sign_out',
          hoursAfterBase(i * 12),
          -1.2921,
          36.8219,
          `seed-correlation-att-${g.code}-${i}`,
        ],
      );
    }

    for (let i = 0; i < PATROL_SCANS_PER_GUARD; i += 1) {
      await client.query(
        `INSERT INTO patrol_scans (
           org_id, client_id, site_id, checkpoint_id, guard_id, device_id,
           client_event_id, occurred_at, scan_method, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [
          org.id,
          org.checkpoint.clientId,
          org.checkpoint.siteId,
          org.checkpoint.id,
          g.id,
          `device-${g.code}`,
          `${g.id.slice(0, 8)}-0000-4000-8000-${String(500 + i).padStart(12, '0')}`,
          hoursAfterBase(i * 3 + 1),
          i % 2 === 0 ? 'nfc' : 'qr',
          `seed-correlation-scan-${g.code}-${i}`,
        ],
      );
    }
  }

  await client.query(
    `INSERT INTO report_runs (
       id, org_id, client_id, period_start, period_end, status, correlation_id, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      org.reportRun.id,
      org.id,
      org.reportRun.clientId,
      hoursAfterBase(0),
      hoursAfterBase(24),
      'complete',
      `seed-correlation-report-${org.slug}`,
      hoursAfterBase(25),
    ],
  );

  await client.query(
    `INSERT INTO report_delivery_log (
       org_id, client_id, report_run_id, recipient_email, delivered_at,
       delivery_status, r2_archive_key, correlation_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      org.id,
      org.reportRun.clientId,
      org.reportRun.id,
      `reports@${org.slug}.test`,
      hoursAfterBase(25),
      'sent',
      `reports/${org.slug}/seed.pdf`,
      `seed-correlation-report-${org.slug}`,
    ],
  );
}

async function seedGlobalConfig(client) {
  // Global config: no tenant GUC, and none needed — alarm_event_type_mappings has no RLS.
  await client.query('SELECT set_config($1, $2, false)', ['app.current_org_id', '']);
  const mappings = [
    ['dahua', '1001', 'intrusion', 'high', 'DSS motion detection / intrusion'],
    ['dahua', '2002', 'door_forced', 'critical', 'DSS door forced open'],
    ['dahua', '3003', 'tamper', 'high', 'DSS camera tamper'],
    ['guardtek', 'PANIC', 'panic', 'critical', 'GuardTek panic button'],
    ['guardtek', 'PATROL_MISS', 'unknown', null, 'GuardTek missed patrol'],
    ['axxon', 'AX_FIRE', 'fire', 'critical', 'AxxonSoft fire detection'],
  ];
  for (const [vendor, code, type, severity, description] of mappings) {
    await client.query(
      `INSERT INTO alarm_event_type_mappings
         (vendor, vendor_code, normalized_type, severity_override, description)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [vendor, code, type, severity, description],
    );
  }
}

/** @param {import('pg').Client} client a connection as deepsight_owner */
export async function seedAll(client) {
  for (const org of ORGS) {
    await seedOrg(client, org);
  }
  await seedGlobalConfig(client);
}
