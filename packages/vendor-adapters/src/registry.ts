import type { AlarmAdapter, VendorId } from '@deepsight/contracts';
import { GuardTekAdapter } from './guardtek/adapter.js';
import { DahuaAdapter } from './dahua/adapter.js';
import { AxxonAdapter } from './axxon/adapter.js';

/**
 * The vendor registry: VendorId -> a fresh adapter instance.
 *
 * The whole point of the adapter layer is that adding a vendor never touches ingestion
 * core, schema, or dashboard code. That promise is only real if there is exactly ONE place
 * that knows the concrete adapter classes — this file. Everything else works against the
 * AlarmAdapter union.
 *
 * The record is typed as Record<VendorId, ...>, so adding a VendorId without a factory
 * here is a COMPILE error: a new vendor cannot be half-registered.
 */
const factories: Record<VendorId, () => AlarmAdapter> = {
  guardtek: () => new GuardTekAdapter(),
  dahua: () => new DahuaAdapter(),
  axxon: () => new AxxonAdapter(),
};

export function createAdapter(vendor: VendorId): AlarmAdapter {
  return factories[vendor]();
}

export function createAllAdapters(): readonly AlarmAdapter[] {
  return (Object.keys(factories) as VendorId[]).map((vendor) => factories[vendor]());
}

export { GuardTekAdapter } from './guardtek/adapter.js';
export { DahuaAdapter } from './dahua/adapter.js';
export { AxxonAdapter } from './axxon/adapter.js';
