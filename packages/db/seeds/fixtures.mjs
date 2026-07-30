/**
 * Deterministic seed identifiers.
 *
 * TWO organizations, each with TWO clients, always. Single-tenant seed data makes every
 * isolation test pass trivially, and under D6 both levels must be represented to prove
 * that org isolation and client narrowing compose correctly rather than one masking the
 * other.
 *
 * Fixed UUIDs so tests can reference rows by identity instead of by fragile ordering.
 */
export const ORG_A = '0a000000-0000-4000-8000-000000000001';
export const ORG_B = '0b000000-0000-4000-8000-000000000001';

export const CLIENT_A1 = '0a000000-0000-4000-8000-0000000000c1';
export const CLIENT_A2 = '0a000000-0000-4000-8000-0000000000c2';
export const CLIENT_B1 = '0b000000-0000-4000-8000-0000000000c1';
export const CLIENT_B2 = '0b000000-0000-4000-8000-0000000000c2';

export const SITE_A1_1 = '0a000000-0000-4000-8000-0000000000f1';
export const SITE_A1_2 = '0a000000-0000-4000-8000-0000000000f2';
export const SITE_A2_1 = '0a000000-0000-4000-8000-0000000000f3';
export const SITE_B1_1 = '0b000000-0000-4000-8000-0000000000f1';

export const GUARD_A1 = '0a000000-0000-4000-8000-000000000a01';
export const GUARD_A2 = '0a000000-0000-4000-8000-000000000a02';
export const GUARD_B1 = '0b000000-0000-4000-8000-000000000a01';

export const USER_A_ADMIN = '0a000000-0000-4000-8000-000000000901';
export const USER_A_SUPERVISOR = '0a000000-0000-4000-8000-000000000902';
export const USER_A_VIEWER_C1 = '0a000000-0000-4000-8000-000000000903';
export const USER_B_SUPERVISOR = '0b000000-0000-4000-8000-000000000901';

export const ENROLLMENT_A1 = '0a000000-0000-4000-8000-000000000e01';
export const ENROLLMENT_A2 = '0a000000-0000-4000-8000-000000000e02';

export const CHECKPOINT_A1_1 = '0a000000-0000-4000-8000-000000000d01';
export const CHECKPOINT_B1_1 = '0b000000-0000-4000-8000-000000000d01';

export const SOURCE_A1 = '0a000000-0000-4000-8000-000000000501';
export const SOURCE_B1 = '0b000000-0000-4000-8000-000000000501';

export const REPORT_RUN_A1 = '0a000000-0000-4000-8000-000000000701';
export const REPORT_RUN_B1 = '0b000000-0000-4000-8000-000000000701';

/**
 * Per-organization seed shape. `marker` is a distinguishable string written into each
 * org's alarm payloads so a leak across the boundary is identifiable in an assertion
 * rather than inferred from a row count.
 */
export const ORGS = [
  {
    id: ORG_A,
    slug: 'org-a',
    name: 'Operator A Security Services',
    marker: 'MARKER_ORG_A',
    clients: [
      { id: CLIENT_A1, name: 'Client A1', sites: [SITE_A1_1, SITE_A1_2] },
      { id: CLIENT_A2, name: 'Client A2', sites: [SITE_A2_1] },
    ],
    guards: [
      { id: GUARD_A1, code: 'A-G001', name: 'Guard A One' },
      { id: GUARD_A2, code: 'A-G002', name: 'Guard A Two' },
    ],
    users: [
      { id: USER_A_ADMIN, email: 'admin@org-a.test', role: 'admin', clientId: null },
      { id: USER_A_SUPERVISOR, email: 'sup@org-a.test', role: 'supervisor', clientId: null },
      // A report_viewer pinned to one client: the reason client_narrowing exists.
      {
        id: USER_A_VIEWER_C1,
        email: 'viewer@org-a.test',
        role: 'report_viewer',
        clientId: CLIENT_A1,
      },
    ],
    enrollments: [
      { id: ENROLLMENT_A1, guardId: GUARD_A1, clientId: CLIENT_A1, deviceId: 'device-a-001' },
      { id: ENROLLMENT_A2, guardId: GUARD_A2, clientId: CLIENT_A1, deviceId: 'device-a-002' },
    ],
    checkpoint: { id: CHECKPOINT_A1_1, siteId: SITE_A1_1, clientId: CLIENT_A1 },
    source: { id: SOURCE_A1, siteId: SITE_A1_1, clientId: CLIENT_A1, vendor: 'guardtek' },
    reportRun: { id: REPORT_RUN_A1, clientId: CLIENT_A1 },
  },
  {
    id: ORG_B,
    slug: 'org-b',
    name: 'Operator B Guarding Ltd',
    marker: 'MARKER_ORG_B',
    clients: [
      { id: CLIENT_B1, name: 'Client B1', sites: [SITE_B1_1] },
      { id: CLIENT_B2, name: 'Client B2', sites: [] },
    ],
    guards: [{ id: GUARD_B1, code: 'B-G001', name: 'Guard B One' }],
    users: [{ id: USER_B_SUPERVISOR, email: 'sup@org-b.test', role: 'supervisor', clientId: null }],
    enrollments: [],
    checkpoint: { id: CHECKPOINT_B1_1, siteId: SITE_B1_1, clientId: CLIENT_B1 },
    source: { id: SOURCE_B1, siteId: SITE_B1_1, clientId: CLIENT_B1, vendor: 'dahua' },
    reportRun: { id: REPORT_RUN_B1, clientId: CLIENT_B1 },
  },
];

/** How many alarm events each seeded client gets. Half are left open (closed_at NULL). */
export const ALARM_EVENTS_PER_CLIENT = 4;
export const ATTENDANCE_PER_GUARD = 3;
export const PATROL_SCANS_PER_GUARD = 2;
