import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { countLeadingZeroBits, getPow } from "./pow.ts";

/** Build a minimal NostrEvent for testing. */
function mkEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "1".repeat(64),
    created_at: 0,
    kind: 1,
    tags: [],
    content: "",
    sig: "2".repeat(128),
    ...overrides,
  };
}

describe("countLeadingZeroBits", () => {
  it("returns 0 for an id starting with f", () => {
    assert.equal(countLeadingZeroBits("f".repeat(64)), 0);
  });

  it("counts the NIP-13 example (36 bits)", () => {
    // From NIP-13: 9 leading hex zeroes = 36 bits.
    assert.equal(
      countLeadingZeroBits(
        "000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d",
      ),
      36,
    );
  });

  it("counts partial leading zeroes in a hex digit", () => {
    // `002f...` = 0000 0000 0010 1111 -> 10 leading zero bits.
    assert.equal(countLeadingZeroBits("002f"), 10);
  });

  it("counts the mined example note id (>= 20 bits)", () => {
    // From NIP-13 example mined note.
    assert.equal(
      countLeadingZeroBits(
        "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
      ),
      21,
    );
  });

  it("returns 4 per fully-zero nibble then stops", () => {
    // 3 leading zero nibbles (12 bits) then `1` (0001 -> 3 more) = 15.
    assert.equal(countLeadingZeroBits("0001"), 15);
  });

  it("returns full length for an all-zero id", () => {
    assert.equal(countLeadingZeroBits("0".repeat(64)), 256);
  });
});

describe("getPow", () => {
  it("returns 0 for events without a nonce tag, even with leading zeroes", () => {
    const event = mkEvent({ id: "0".repeat(64), tags: [] });
    assert.equal(getPow(event), 0);
  });

  it("computes difficulty for a mined event with a nonce tag", () => {
    const event = mkEvent({
      id: "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
      tags: [["nonce", "776797"]],
    });
    assert.equal(getPow(event), 21);
  });

  it("clamps difficulty to the committed target in the nonce tag", () => {
    // Actual difficulty is 21, but the miner only committed to 20.
    const event = mkEvent({
      id: "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
      tags: [["nonce", "776797", "20"]],
    });
    assert.equal(getPow(event), 20);
  });

  it("falls back to actual difficulty when commitment exceeds it", () => {
    // Miner claims a target of 40 but the id only has 21 leading zero bits.
    const event = mkEvent({
      id: "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
      tags: [["nonce", "776797", "40"]],
    });
    assert.equal(getPow(event), 21);
  });

  it("ignores a non-numeric committed target", () => {
    const event = mkEvent({
      id: "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358",
      tags: [["nonce", "776797", "abc"]],
    });
    assert.equal(getPow(event), 21);
  });

  it("returns 0 for a nonce-tagged event with no leading zeroes", () => {
    const event = mkEvent({ id: "f".repeat(64), tags: [["nonce", "1"]] });
    assert.equal(getPow(event), 0);
  });
});
