import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from 'uuidv7';

/**
 * Correlation context.
 *
 * Held in AsyncLocalStorage rather than threaded through every function signature.
 * The brief requires one correlation id to survive ingestion -> normalization ->
 * persistence -> dashboard push -> report run -> delivery; passing it explicitly
 * through that many layers guarantees somebody drops it, and a dropped id is only
 * discovered during the incident it was meant to help with.
 */
export interface CorrelationContext {
  readonly correlationId: string;
  readonly orgId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly vendor?: string | undefined;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newCorrelationId(): string {
  return uuidv7();
}

/** Runs `fn` with the given correlation context visible to every awaited descendant. */
export function withCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Adds fields to the current context for the duration of `fn`, e.g. attaching an
 * orgId once it has been resolved from a vendor payload.
 */
export function extendCorrelation<T>(
  fields: Omit<Partial<CorrelationContext>, 'correlationId'>,
  fn: () => T,
): T {
  const existing = storage.getStore();
  const base: CorrelationContext = existing ?? { correlationId: newCorrelationId() };
  return storage.run({ ...base, ...fields }, fn);
}
