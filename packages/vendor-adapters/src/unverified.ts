/**
 * The unverified-contract policy.
 *
 * GuardTek's WSDL and auth, Dahua DSS's webhook signature scheme, and AxxonSoft's stream
 * endpoint are all unconfirmed (open items 1-3). The brief is explicit about what to do:
 * build each adapter as a typed class implementing the real interface, with unverifiable
 * methods throwing — never invent endpoint behaviour, never mock a response shape as if it
 * were real, never reach for `any` to paper over an unknown schema.
 *
 * The reason that matters more than tidiness: a plausible-looking mock is indistinguishable
 * from a working integration until the day it meets the real vendor. An adapter that throws
 * a message naming exactly what needs confirming cannot be mistaken for finished, and it
 * tells whoever picks it up what to ask the vendor for.
 */
export class UnverifiedVendorContractError extends Error {
  public readonly vendor: string;
  public readonly operation: string;

  constructor(vendor: string, operation: string, needed: string) {
    super(`UNVERIFIED_VENDOR_CONTRACT: ${vendor}.${operation} — ${needed}`);
    this.name = 'UnverifiedVendorContractError';
    this.vendor = vendor;
    this.operation = operation;
  }
}

/**
 * Throws with a message naming the vendor, the operation, and what must be confirmed.
 *
 * Every such site is also listed in packages/vendor-adapters/VENDOR_TODO.md, so the
 * outstanding vendor questions can be read without grepping the source.
 */
export function unverified(vendor: string, operation: string, needed: string): never {
  throw new UnverifiedVendorContractError(vendor, operation, needed);
}
