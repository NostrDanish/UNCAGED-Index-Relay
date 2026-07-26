/**
 * Typed errors thrown by ingest backpressure paths.
 *
 * The relay distinguishes these from other errors so it can reply with a
 * standard `OK false "error: relay overloaded ..."` to the client (per
 * NIP-01), letting upstream bridges back off naturally instead of holding
 * the connection while we OOM.
 */

/** The OpenSearch bulk indexing queue exceeded its configured cap. */
export class StorageOverloaded extends Error {
  constructor(queued: number, max: number) {
    super(`storage overloaded (${queued}/${max} queued)`);
    this.name = "StorageOverloaded";
  }
}
