/**
 * Typed errors thrown by ingest backpressure paths.
 *
 * The relay distinguishes these from other errors so it can reply with a
 * standard `OK false "error: relay overloaded ..."` to the client (per
 * NIP-01), letting upstream bridges back off naturally instead of holding
 * the connection while we OOM.
 */

/** The analyze worker pool's pending queue exceeded its configured cap. */
export class AnalyzePoolOverloaded extends Error {
  constructor(pending: number, max: number) {
    super(`analyze pool overloaded (${pending}/${max} pending)`);
    this.name = "AnalyzePoolOverloaded";
  }
}

/** The OpenSearch bulk indexing queue exceeded its configured cap. */
export class StorageOverloaded extends Error {
  constructor(queued: number, max: number) {
    super(`storage overloaded (${queued}/${max} queued)`);
    this.name = "StorageOverloaded";
  }
}

/**
 * The raw frame received from the WebSocket was unparseable JSON or did not
 * pass the off-thread structural validation. Used by the relay to translate
 * worker-reported parse failures into the same OK/NOTICE responses the
 * main-thread validator used to produce.
 */
export class FrameParseError extends Error {
  /** Optional 64-hex event ID we managed to extract from a partially-valid payload. */
  readonly eventId?: string;
  constructor(message: string, eventId?: string) {
    super(message);
    this.name = "FrameParseError";
    this.eventId = eventId;
  }
}
