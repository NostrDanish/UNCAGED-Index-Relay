import type { NostrEvent } from "nostr-tools";

/**
 * NIP-13 Proof of Work.
 *
 * The difficulty of an event is the number of leading zero bits in its
 * NIP-01 `id` (a lowercase 64-char hex SHA-256 hash). Because the id is
 * already computed and stored on every event, calculating difficulty is a
 * cheap scan of the hex string — no hashing required.
 */

/**
 * Count the number of leading zero bits in a hex string.
 *
 * Each fully-zero nibble (`0`) contributes 4 bits. The first non-zero nibble
 * contributes its own leading-zero count (`Math.clz32(nibble) - 28`, since a
 * nibble is 4 bits and clz32 operates on 32-bit integers), after which the
 * scan stops.
 *
 * Mirrors the reference JavaScript implementation in NIP-13.
 */
export function countLeadingZeroBits(hex: string): number {
  let count = 0;

  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i], 16);
    // Treat malformed hex (NaN) as a hard stop rather than counting it.
    if (Number.isNaN(nibble)) break;
    if (nibble === 0) {
      count += 4;
    } else {
      count += Math.clz32(nibble) - 28;
      break;
    }
  }

  return count;
}

/**
 * Compute the NIP-13 proof-of-work difficulty for an event.
 *
 * Difficulty is the number of leading zero bits in the event `id`. Per
 * NIP-13, an honest miner commits a target difficulty in the third value of
 * the `nonce` tag (`["nonce", <nonce>, <target>]`). When such a commitment is
 * present, the returned difficulty is clamped to the committed target so that
 * a spammer targeting a low difficulty who "gets lucky" and matches more
 * leading zeroes cannot be credited with a higher difficulty than committed.
 *
 * Events without a `nonce` tag return `0` — they were not mined, so they have
 * no meaningful (claimed) proof of work regardless of any incidental leading
 * zeroes in their id.
 */
export function getPow(event: NostrEvent): number {
  const nonceTag = event.tags.find((tag) => tag[0] === "nonce");
  if (!nonceTag) return 0;

  const difficulty = countLeadingZeroBits(event.id);

  // Honour a committed target difficulty (third value of the nonce tag).
  // If the actual difficulty is below the commitment, the commitment is a
  // lie — fall back to the actual (lower) difficulty rather than crediting
  // the unmet target.
  const committed = nonceTag[2];
  if (committed !== undefined && /^\d+$/.test(committed)) {
    const target = Number.parseInt(committed, 10);
    return Math.min(difficulty, target);
  }

  return difficulty;
}
