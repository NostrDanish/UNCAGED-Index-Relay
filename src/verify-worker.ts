/// Worker thread that performs Nostr event signature verification.
/// Uses nostr-wasm (libsecp256k1 compiled to WASM) for ~4.5x faster
/// schnorr verification compared to nostr-tools' pure JS implementation.
/// Receives a NostrEvent via postMessage, returns { id, valid }.

declare var self: Worker;

import type { NostrEvent } from "nostr-tools";
import { initNostrWasm } from "nostr-wasm";

const nw = await initNostrWasm();

self.onmessage = (event: MessageEvent<NostrEvent>) => {
  const nostrEvent = event.data;
  let valid: boolean;
  try {
    nw.verifyEvent(nostrEvent);
    valid = true;
  } catch {
    valid = false;
  }
  postMessage({ id: `${nostrEvent.id}:${nostrEvent.sig}`, valid });
};
