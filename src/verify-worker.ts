/// Worker thread that performs Nostr event signature verification.
/// Receives a NostrEvent via postMessage, returns { id, valid }.

declare var self: Worker;

import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

self.onmessage = (event: MessageEvent<NostrEvent>) => {
  const nostrEvent = event.data;
  const valid = verifyEvent(nostrEvent);
  postMessage({ id: `${nostrEvent.id}:${nostrEvent.sig}`, valid });
};
