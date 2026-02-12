/// Worker thread that performs Nostr event signature verification.
/// Receives events via postMessage, returns { id, valid } results.

declare var self: Worker;

import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

self.onmessage = (event: MessageEvent<{ id: string; event: NostrEvent }>) => {
  const { id, event: nostrEvent } = event.data;
  const valid = verifyEvent(nostrEvent);
  postMessage({ id, valid });
};
