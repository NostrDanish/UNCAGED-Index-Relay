/**
 * Negentropy Protocol V1 — NIP-77 set reconciliation.
 *
 * Implements the wire protocol described in the NIP-77 appendix
 * (https://github.com/nostr-protocol/nips/blob/master/77.md), which is a
 * Nostr-friendly wrapper around hoytech's Negentropy range-based set
 * reconciliation (https://github.com/hoytech/negentropy).
 *
 * Records are (timestamp, 32-byte ID) pairs sorted ascending by timestamp,
 * ties broken by ID bytes ascending. Both the server role (relay answering
 * `NEG-OPEN`/`NEG-MSG`) and the initiator role (used by tests and potential
 * relay-to-relay sync) are implemented.
 *
 * Uses only Node.js builtins (`node:crypto`, `node:buffer`) so the module
 * stays portable.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** Protocol version byte for Negentropy Protocol V1. */
export const PROTOCOL_VERSION = 0x61;

/** Size of a record ID in bytes. */
export const ID_SIZE = 32;

/** Size of a range fingerprint in bytes. */
export const FINGERPRINT_SIZE = 16;

/**
 * Sentinel for the protocol's "infinity" timestamp (wire value uint64 max).
 * Any decoded timestamp at or above this value is treated as infinity.
 */
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

/** Number of fingerprint buckets a non-matching range is split into. */
const SPLIT_BUCKETS = 16;

/** Range payload modes. */
const Mode = {
  Skip: 0,
  Fingerprint: 1,
  IdList: 2,
} as const;

/** An (inclusive-lower / exclusive-upper) range boundary. `id` may be a
 *  prefix of up to 32 bytes; omitted trailing bytes are implicitly zero. */
export interface Bound {
  timestamp: number;
  id: Uint8Array;
}

const EMPTY_ID = new Uint8Array(0);

/** The bound covering everything (infinity timestamp, empty ID prefix). */
function infinityBound(): Bound {
  return { timestamp: MAX_TIMESTAMP, id: EMPTY_ID };
}

// ---------------------------------------------------------------------------
// Varint
// ---------------------------------------------------------------------------

/** Threshold above which `result * 128 + digit` could exceed MAX_SAFE_INTEGER. */
const VARINT_SAFE_LIMIT = (Number.MAX_SAFE_INTEGER - 127) / 128;

/** Encode a non-negative integer as a base-128 varint (MSB-first). */
export function encodeVarInt(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("varint must be a non-negative integer");
  }
  if (n === 0) return new Uint8Array([0]);

  const digits: number[] = [];
  while (n > 0) {
    digits.push(n % 128);
    n = Math.floor(n / 128);
  }
  digits.reverse();
  for (let i = 0; i < digits.length - 1; i++) {
    digits[i] |= 0x80;
  }
  return new Uint8Array(digits);
}

// ---------------------------------------------------------------------------
// Byte buffers
// ---------------------------------------------------------------------------

/** Sequential reader over a Uint8Array with bounds checking. */
class Reader {
  private pos = 0;

  constructor(private buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readByte(): number {
    if (this.pos >= this.buf.length) {
      throw new Error("negentropy message ends prematurely");
    }
    return this.buf[this.pos++];
  }

  readBytes(n: number): Uint8Array {
    if (this.remaining < n) {
      throw new Error("negentropy message ends prematurely");
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readVarInt(): number {
    let result = 0;
    while (true) {
      if (result > VARINT_SAFE_LIMIT) {
        throw new Error("varint too large");
      }
      const byte = this.readByte();
      result = result * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return result;
  }
}

/** Growable byte writer that tracks its length cheaply. */
class Writer {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  byte(b: number): void {
    this.chunks.push(new Uint8Array([b]));
    this._length += 1;
  }

  bytes(b: Uint8Array): void {
    this.chunks.push(b);
    this._length += b.length;
  }

  varint(n: number): void {
    this.bytes(encodeVarInt(n));
  }

  /** Append another writer's contents (and reset it). */
  extend(other: Writer): void {
    for (const chunk of other.chunks) {
      this.chunks.push(chunk);
    }
    this._length += other._length;
    other.chunks = [];
    other._length = 0;
  }

  unwrap(): Uint8Array {
    const out = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Lexical byte comparison. When one array is a prefix of the other, the
 * shorter sorts first — equivalent to implicit zero-padding for the purpose
 * of lower-bound searches.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** A single reconciliation record. */
export interface Item {
  timestamp: number;
  id: Uint8Array;
}

/**
 * Compact sorted vector of (timestamp, id) records.
 *
 * Timestamps are kept in a plain number array and IDs in a single growable
 * byte buffer (32 bytes per record), so a million records costs ~40 MB
 * instead of the ~100+ MB an array of objects would.
 */
export class NegentropyStorageVector {
  private timestamps: number[] = [];
  private idBuf = new Uint8Array(ID_SIZE * 64);
  private sealed = false;

  get size(): number {
    return this.timestamps.length;
  }

  /** Insert a record. ID must be exactly 32 bytes. */
  insert(timestamp: number, id: Uint8Array): void {
    if (this.sealed) throw new Error("already sealed");
    if (id.length !== ID_SIZE) {
      throw new Error(`item ID must be ${ID_SIZE} bytes`);
    }
    if (
      !Number.isInteger(timestamp) ||
      timestamp < 0 ||
      timestamp >= MAX_TIMESTAMP
    ) {
      throw new Error("item timestamp out of range");
    }

    const index = this.timestamps.length;
    if ((index + 1) * ID_SIZE > this.idBuf.length) {
      const grown = new Uint8Array(this.idBuf.length * 2);
      grown.set(this.idBuf);
      this.idBuf = grown;
    }
    this.idBuf.set(id, index * ID_SIZE);
    this.timestamps.push(timestamp);
  }

  /** Insert a record with a lowercase hex-encoded 64-char ID. */
  insertHex(timestamp: number, idHex: string): void {
    if (!/^[0-9a-f]{64}$/.test(idHex)) {
      throw new Error("item ID must be 64 lowercase hex chars");
    }
    this.insert(timestamp, Uint8Array.from(Buffer.from(idHex, "hex")));
  }

  /**
   * Seal the vector: verify (or establish) sorted order and reject
   * duplicate records. Must be called before use in reconciliation.
   */
  seal(): void {
    if (this.sealed) throw new Error("already sealed");

    if (!this.isSorted()) {
      this.sortInPlace();
    }

    // Reject duplicates (adjacent after sorting).
    for (let i = 1; i < this.size; i++) {
      if (this.compareItems(i - 1, i) === 0) {
        throw new Error("duplicate item inserted");
      }
    }

    this.sealed = true;
  }

  getItem(index: number): Item {
    this.checkSealed();
    if (index < 0 || index >= this.size) {
      throw new Error("item index out of range");
    }
    return { timestamp: this.timestamps[index], id: this.getId(index) };
  }

  /**
   * Iterate records in [begin, end). The callback may return `false` to
   * stop early.
   */
  iterate(
    begin: number,
    end: number,
    cb: (item: Item, index: number) => boolean,
  ): void {
    this.checkSealed();
    this.checkBounds(begin, end);
    for (let i = begin; i < end; i++) {
      if (!cb({ timestamp: this.timestamps[i], id: this.getId(i) }, i)) break;
    }
  }

  /** Find the first index in [first, last) whose record is >= bound. */
  findLowerBound(first: number, last: number, bound: Bound): number {
    this.checkSealed();
    this.checkBounds(first, last);

    let lo = first;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareItemToBound(mid, bound) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Compute the fingerprint of records in [begin, end): SHA-256 of
   * (sum of IDs as 32-byte little-endian integers mod 2^256, concatenated
   * with the record count as a varint), truncated to 16 bytes.
   */
  fingerprint(begin: number, end: number): Uint8Array {
    this.checkSealed();
    this.checkBounds(begin, end);

    // Addition mod 2^256 over little-endian 32-byte integers.
    const acc = new Uint8Array(ID_SIZE);
    for (let i = begin; i < end; i++) {
      let carry = 0;
      const offset = i * ID_SIZE;
      for (let j = 0; j < ID_SIZE; j++) {
        const t = acc[j] + this.idBuf[offset + j] + carry;
        acc[j] = t & 0xff;
        carry = t >> 8;
      }
      // Final carry is dropped (mod 2^256).
    }

    const hash = createHash("sha256")
      .update(acc)
      .update(encodeVarInt(end - begin))
      .digest();

    return Uint8Array.from(hash.subarray(0, FINGERPRINT_SIZE));
  }

  private getId(index: number): Uint8Array {
    return this.idBuf.subarray(index * ID_SIZE, (index + 1) * ID_SIZE);
  }

  private compareItems(a: number, b: number): number {
    if (this.timestamps[a] !== this.timestamps[b]) {
      return this.timestamps[a] - this.timestamps[b];
    }
    return compareBytes(this.getId(a), this.getId(b));
  }

  private compareItemToBound(index: number, bound: Bound): number {
    if (this.timestamps[index] !== bound.timestamp) {
      return this.timestamps[index] - bound.timestamp;
    }
    return compareBytes(this.getId(index), bound.id);
  }

  private isSorted(): boolean {
    for (let i = 1; i < this.size; i++) {
      if (this.compareItems(i - 1, i) > 0) return false;
    }
    return true;
  }

  /** Sort records via an index permutation, then rebuild the buffers. */
  private sortInPlace(): void {
    const indices = this.timestamps.map((_, i) => i);
    indices.sort((a, b) => this.compareItems(a, b));

    const newTimestamps = new Array<number>(this.size);
    const newIdBuf = new Uint8Array(this.idBuf.length);
    for (let i = 0; i < indices.length; i++) {
      const from = indices[i];
      newTimestamps[i] = this.timestamps[from];
      newIdBuf.set(this.getId(from), i * ID_SIZE);
    }
    this.timestamps = newTimestamps;
    this.idBuf = newIdBuf;
  }

  private checkSealed(): void {
    if (!this.sealed) throw new Error("not sealed");
  }

  private checkBounds(begin: number, end: number): void {
    if (begin > end || end > this.size) {
      throw new Error("bad range");
    }
  }
}

// ---------------------------------------------------------------------------
// Negentropy reconciliation
// ---------------------------------------------------------------------------

/** Result of an initiator-side reconciliation round. */
export interface ReconcileResult {
  /** Next message to send, or `null` when reconciliation is complete
   *  (initiator only — the server role always produces a message). */
  message: Uint8Array | null;
  /** Hex IDs the local side has that the remote side lacks (cumulative). */
  haveIds: string[];
  /** Hex IDs the remote side has that the local side lacks (cumulative). */
  needIds: string[];
}

/**
 * One side of a Negentropy V1 reconciliation.
 *
 * Server role (relay): construct with a sealed storage vector and call
 * {@link reconcile} for each incoming message; send back the returned bytes.
 *
 * Initiator role (client): call {@link initiate} to produce the first
 * message, then feed each response through {@link reconcile} until it
 * returns a `null` message. Accumulated `haveIds`/`needIds` describe the
 * set difference.
 */
export class Negentropy {
  private storage: NegentropyStorageVector;
  private frameSizeLimit: number;
  private isInitiator = false;
  private lastTimestampIn = 0;
  private lastTimestampOut = 0;
  private haveIds: string[] = [];
  private needIds: string[] = [];

  /**
   * @param storage Sealed storage vector of local records.
   * @param frameSizeLimit Maximum size (bytes) of produced messages.
   *   `0` disables the limit. Must be >= 4096 when set.
   */
  constructor(storage: NegentropyStorageVector, frameSizeLimit = 0) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) {
      throw new Error("frameSizeLimit too small");
    }
    this.storage = storage;
    this.frameSizeLimit = frameSizeLimit;
  }

  /** Build the initial message (initiator role). */
  initiate(): Uint8Array {
    if (this.isInitiator) throw new Error("already initiated");
    this.isInitiator = true;

    this.lastTimestampOut = 0;
    const output = new Writer();
    output.byte(PROTOCOL_VERSION);
    this.splitRange(0, this.storage.size, infinityBound(), output);
    return output.unwrap();
  }

  /**
   * Process an incoming message and produce the local response.
   *
   * For the server role the returned `message` is always non-null. For the
   * initiator role a `null` message means reconciliation is complete.
   */
  reconcile(query: Uint8Array): ReconcileResult {
    this.lastTimestampIn = 0;
    this.lastTimestampOut = 0;

    const reader = new Reader(query);
    const fullOutput = new Writer();
    fullOutput.byte(PROTOCOL_VERSION);

    const protocolVersion = reader.readByte();
    if (protocolVersion < 0x60 || protocolVersion > 0x6f) {
      throw new Error("invalid negentropy protocol version byte");
    }
    if (protocolVersion !== PROTOCOL_VERSION) {
      if (this.isInitiator) {
        throw new Error(
          `unsupported negentropy protocol version requested: ${protocolVersion - 0x60}`,
        );
      }
      // Reply with a bare version byte: the highest version we support.
      return this.result(fullOutput.unwrap());
    }

    const storageSize = this.storage.size;
    let prevBound: Bound = { timestamp: 0, id: EMPTY_ID };
    let prevIndex = 0;
    let skip = false;

    while (reader.remaining > 0) {
      const o = new Writer();

      const doSkip = () => {
        if (skip) {
          skip = false;
          this.encodeBound(prevBound, o);
          o.varint(Mode.Skip);
        }
      };

      const currBound = this.decodeBound(reader);
      const mode = reader.readVarInt();

      const lower = prevIndex;
      let upper = this.storage.findLowerBound(
        prevIndex,
        storageSize,
        currBound,
      );

      if (mode === Mode.Skip) {
        skip = true;
      } else if (mode === Mode.Fingerprint) {
        const theirFingerprint = reader.readBytes(FINGERPRINT_SIZE);
        const ourFingerprint = this.storage.fingerprint(lower, upper);

        if (compareBytes(theirFingerprint, ourFingerprint) !== 0) {
          doSkip();
          this.splitRange(lower, upper, currBound, o);
        } else {
          skip = true;
        }
      } else if (mode === Mode.IdList) {
        const numIds = reader.readVarInt();

        const theirElems = new Map<string, Uint8Array>();
        for (let i = 0; i < numIds; i++) {
          const id = reader.readBytes(ID_SIZE);
          theirElems.set(Buffer.from(id).toString("hex"), id);
        }

        this.storage.iterate(lower, upper, (item) => {
          const k = Buffer.from(item.id).toString("hex");
          if (!theirElems.has(k)) {
            // ID exists on our side but not theirs.
            if (this.isInitiator) this.haveIds.push(k);
          } else {
            // ID exists on both sides.
            theirElems.delete(k);
          }
          return true;
        });

        if (this.isInitiator) {
          skip = true;
          for (const k of theirElems.keys()) {
            // ID exists on their side but not ours.
            this.needIds.push(k);
          }
        } else {
          doSkip();

          const responseIds = new Writer();
          let numResponseIds = 0;
          let endBound = currBound;

          this.storage.iterate(lower, upper, (item, index) => {
            if (
              this.exceededFrameSizeLimit(
                fullOutput.length + responseIds.length,
              )
            ) {
              endBound = item;
              upper = index; // Remaining items get covered by the final fingerprint range.
              return false;
            }
            responseIds.bytes(Uint8Array.from(item.id));
            numResponseIds++;
            return true;
          });

          this.encodeBound(endBound, o);
          o.varint(Mode.IdList);
          o.varint(numResponseIds);
          o.extend(responseIds);

          fullOutput.extend(o);
        }
      } else {
        throw new Error(`unexpected negentropy mode: ${mode}`);
      }

      if (this.exceededFrameSizeLimit(fullOutput.length + o.length)) {
        // Frame full: stop processing and fingerprint the remaining range so
        // the remote side knows to revisit it next round.
        const remainingFingerprint = this.storage.fingerprint(
          upper,
          storageSize,
        );
        this.encodeBound(infinityBound(), fullOutput);
        fullOutput.varint(Mode.Fingerprint);
        fullOutput.bytes(remainingFingerprint);
        break;
      }

      fullOutput.extend(o);
      prevIndex = upper;
      prevBound = currBound;
    }

    const message =
      fullOutput.length === 1 && this.isInitiator ? null : fullOutput.unwrap();
    return this.result(message);
  }

  private result(message: Uint8Array | null): ReconcileResult {
    return { message, haveIds: this.haveIds, needIds: this.needIds };
  }

  /**
   * Cover [lower, upper) with ranges ending at upperBound: a single IdList
   * for small ranges, or {@link SPLIT_BUCKETS} fingerprint buckets.
   */
  private splitRange(
    lower: number,
    upper: number,
    upperBound: Bound,
    output: Writer,
  ): void {
    const numElems = upper - lower;

    if (numElems < SPLIT_BUCKETS * 2) {
      this.encodeBound(upperBound, output);
      output.varint(Mode.IdList);
      output.varint(numElems);
      this.storage.iterate(lower, upper, (item) => {
        output.bytes(Uint8Array.from(item.id));
        return true;
      });
      return;
    }

    const itemsPerBucket = Math.floor(numElems / SPLIT_BUCKETS);
    const bucketsWithExtra = numElems % SPLIT_BUCKETS;
    let curr = lower;

    for (let i = 0; i < SPLIT_BUCKETS; i++) {
      const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0);
      const ourFingerprint = this.storage.fingerprint(curr, curr + bucketSize);
      curr += bucketSize;

      const bound =
        curr === upper
          ? upperBound
          : this.getMinimalBound(
              this.storage.getItem(curr - 1),
              this.storage.getItem(curr),
            );

      this.encodeBound(bound, output);
      output.varint(Mode.Fingerprint);
      output.bytes(ourFingerprint);
    }
  }

  /** Shortest bound that separates `prev` from `curr`. */
  private getMinimalBound(prev: Item, curr: Item): Bound {
    if (curr.timestamp !== prev.timestamp) {
      return { timestamp: curr.timestamp, id: EMPTY_ID };
    }

    let sharedPrefixBytes = 0;
    for (let i = 0; i < ID_SIZE; i++) {
      if (curr.id[i] !== prev.id[i]) break;
      sharedPrefixBytes++;
    }
    return {
      timestamp: curr.timestamp,
      id: Uint8Array.from(curr.id.subarray(0, sharedPrefixBytes + 1)),
    };
  }

  private exceededFrameSizeLimit(n: number): boolean {
    return this.frameSizeLimit !== 0 && n > this.frameSizeLimit - 200;
  }

  // -- Bound encoding -------------------------------------------------------

  private encodeTimestampOut(timestamp: number): Uint8Array {
    if (timestamp === MAX_TIMESTAMP) {
      this.lastTimestampOut = MAX_TIMESTAMP;
      return encodeVarInt(0);
    }
    const delta = timestamp - this.lastTimestampOut;
    this.lastTimestampOut = timestamp;
    return encodeVarInt(delta + 1);
  }

  private decodeTimestampIn(reader: Reader): number {
    let timestamp = reader.readVarInt();
    timestamp = timestamp === 0 ? MAX_TIMESTAMP : timestamp - 1;
    if (this.lastTimestampIn === MAX_TIMESTAMP) {
      timestamp = MAX_TIMESTAMP;
    } else {
      timestamp += this.lastTimestampIn;
      if (timestamp >= MAX_TIMESTAMP) timestamp = MAX_TIMESTAMP;
    }
    this.lastTimestampIn = timestamp;
    return timestamp;
  }

  private encodeBound(bound: Bound, output: Writer): void {
    output.bytes(this.encodeTimestampOut(bound.timestamp));
    output.varint(bound.id.length);
    output.bytes(bound.id);
  }

  private decodeBound(reader: Reader): Bound {
    const timestamp = this.decodeTimestampIn(reader);
    const len = reader.readVarInt();
    if (len > ID_SIZE) throw new Error("bound key too long");
    const id = Uint8Array.from(reader.readBytes(len));
    return { timestamp, id };
  }
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/** Decode a hex string to bytes. Throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  if (!/^[0-9a-f]*$/.test(hex)) {
    throw new Error("invalid hex");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Encode bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
