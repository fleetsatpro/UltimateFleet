/** Runs migrations as deepsight_owner. `count` applies to `down`; undefined means all. */
export declare function migrate(
  direction: 'up' | 'down',
  count?: number | undefined,
): Promise<unknown[]>;
