import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  bytesToHex,
  encodeVarInt,
  hexToBytes,
  Negentropy,
  NegentropyStorageVector,
  PROTOCOL_VERSION,
} from "./negentropy.ts";

/** Deterministic pseudo-ID: SHA-256 of a seed string (32 bytes). */
function makeId(seed: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(seed).digest());
}

/** Build a sealed vector from (timestamp, id) pairs. */
function makeVector(
  items: Array<{ timestamp: number; id: Uint8Array }>,
): NegentropyStorageVector {
  const vector = new NegentropyStorageVector();
  for (const item of items) {
    vector.insert(item.timestamp, item.id);
  }
  vector.seal();
  return vector;
}

/**
 * Run a full reconciliation between a client set and a server set.
 * Returns the client's accumulated have/need hex IDs.
 */
function sync(
  clientItems: Array<{ timestamp: number; id: Uint8Array }>,
  serverItems: Array<{ timestamp: number; id: Uint8Array }>,
  opts?: { clientFrameLimit?: number; serverFrameLimit?: number },
): { haveIds: string[]; needIds: string[]; rounds: number } {
  const client = new Negentropy(
    makeVector(clientItems),
    opts?.clientFrameLimit ?? 0,
  );
  const server = new Negentropy(
    makeVector(serverItems),
    opts?.serverFrameLimit ?? 0,
  );

  let message: Uint8Array | null = client.initiate();
  let rounds = 0;
  let haveIds: string[] = [];
  let needIds: string[] = [];

  while (message !== null) {
    rounds++;
    assert.ok(rounds < 200, "reconciliation did not converge");

    const serverResult = server.reconcile(message);
    assert.ok(serverResult.message !== null, "server must always respond");

    const clientResult = client.reconcile(serverResult.message);
    message = clientResult.message;
    haveIds = clientResult.haveIds;
    needIds = clientResult.needIds;
  }

  return { haveIds, needIds, rounds };
}

/** Compute the expected set difference as sorted hex arrays. */
function expectedDiff(
  clientItems: Array<{ timestamp: number; id: Uint8Array }>,
  serverItems: Array<{ timestamp: number; id: Uint8Array }>,
): { have: string[]; need: string[] } {
  const clientSet = new Set(clientItems.map((i) => bytesToHex(i.id)));
  const serverSet = new Set(serverItems.map((i) => bytesToHex(i.id)));
  const have = [...clientSet].filter((id) => !serverSet.has(id)).sort();
  const need = [...serverSet].filter((id) => !clientSet.has(id)).sort();
  return { have, need };
}

function assertSync(
  clientItems: Array<{ timestamp: number; id: Uint8Array }>,
  serverItems: Array<{ timestamp: number; id: Uint8Array }>,
  opts?: { clientFrameLimit?: number; serverFrameLimit?: number },
): void {
  const result = sync(clientItems, serverItems, opts);
  const expected = expectedDiff(clientItems, serverItems);
  assert.deepEqual([...result.haveIds].sort(), expected.have);
  assert.deepEqual([...result.needIds].sort(), expected.need);
}

describe("encodeVarInt", () => {
  it("encodes zero as a single byte", () => {
    assert.deepEqual([...encodeVarInt(0)], [0]);
  });

  it("encodes single-digit values", () => {
    assert.deepEqual([...encodeVarInt(1)], [1]);
    assert.deepEqual([...encodeVarInt(127)], [127]);
  });

  it("encodes multi-digit values MSB-first with continuation bits", () => {
    assert.deepEqual([...encodeVarInt(128)], [0x81, 0x00]);
    assert.deepEqual([...encodeVarInt(255)], [0x81, 0x7f]);
    assert.deepEqual([...encodeVarInt(16384)], [0x81, 0x80, 0x00]);
  });

  it("rejects negative and non-integer values", () => {
    assert.throws(() => encodeVarInt(-1));
    assert.throws(() => encodeVarInt(1.5));
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const bytes = Uint8Array.from(randomBytes(32));
    assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
  });

  it("rejects odd-length and non-hex strings", () => {
    assert.throws(() => hexToBytes("abc"));
    assert.throws(() => hexToBytes("zz"));
    assert.throws(() => hexToBytes("ABCD")); // uppercase not allowed
  });
});

describe("NegentropyStorageVector", () => {
  it("rejects IDs that are not 32 bytes", () => {
    const vector = new NegentropyStorageVector();
    assert.throws(() => vector.insert(1, new Uint8Array(31)));
  });

  it("rejects duplicate items on seal", () => {
    const vector = new NegentropyStorageVector();
    const id = makeId("dup");
    vector.insert(10, id);
    vector.insert(10, id);
    assert.throws(() => vector.seal(), /duplicate/);
  });

  it("sorts unsorted input on seal", () => {
    const vector = new NegentropyStorageVector();
    vector.insert(30, makeId("c"));
    vector.insert(10, makeId("a"));
    vector.insert(20, makeId("b"));
    vector.seal();

    assert.equal(vector.getItem(0).timestamp, 10);
    assert.equal(vector.getItem(1).timestamp, 20);
    assert.equal(vector.getItem(2).timestamp, 30);
  });

  it("sorts equal timestamps by ID bytes ascending", () => {
    const ids = [makeId("x"), makeId("y"), makeId("z")];
    const sorted = [...ids].sort((a, b) => {
      for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    });

    const vector = new NegentropyStorageVector();
    for (const id of ids) vector.insert(5, id);
    vector.seal();

    for (let i = 0; i < sorted.length; i++) {
      assert.deepEqual(vector.getItem(i).id, sorted[i]);
    }
  });

  it("computes the fingerprint per the NIP-77 algorithm", () => {
    const a = makeId("a");
    const b = makeId("b");
    const vector = makeVector([
      { timestamp: 1, id: a },
      { timestamp: 2, id: b },
    ]);

    // Reference computation: little-endian sum mod 2^256, then
    // SHA-256(sum || varint(count))[0..16].
    let sum = 0n;
    for (const id of [a, b]) {
      let value = 0n;
      for (let i = 31; i >= 0; i--) {
        value = (value << 8n) | BigInt(id[i]);
      }
      sum = (sum + value) & ((1n << 256n) - 1n);
    }
    const sumBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      sumBytes[i] = Number((sum >> BigInt(8 * i)) & 0xffn);
    }
    const expected = createHash("sha256")
      .update(sumBytes)
      .update(encodeVarInt(2))
      .digest()
      .subarray(0, 16);

    assert.deepEqual(vector.fingerprint(0, 2), Uint8Array.from(expected));
  });

  it("findLowerBound returns the first index >= bound", () => {
    const vector = makeVector([
      { timestamp: 10, id: makeId("a") },
      { timestamp: 20, id: makeId("b") },
      { timestamp: 30, id: makeId("c") },
    ]);

    assert.equal(
      vector.findLowerBound(0, 3, { timestamp: 0, id: new Uint8Array(0) }),
      0,
    );
    assert.equal(
      vector.findLowerBound(0, 3, { timestamp: 15, id: new Uint8Array(0) }),
      1,
    );
    assert.equal(
      vector.findLowerBound(0, 3, { timestamp: 31, id: new Uint8Array(0) }),
      3,
    );
  });
});

describe("Negentropy reconciliation", () => {
  it("handles two empty sets", () => {
    assertSync([], []);
  });

  it("handles an empty client", () => {
    const serverItems = Array.from({ length: 50 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`server-${i}`),
    }));
    assertSync([], serverItems);
  });

  it("handles an empty server", () => {
    const clientItems = Array.from({ length: 50 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`client-${i}`),
    }));
    assertSync(clientItems, []);
  });

  it("converges immediately when sets are identical", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`shared-${i}`),
    }));
    const result = sync(items, items);
    assert.deepEqual(result.haveIds, []);
    assert.deepEqual(result.needIds, []);
  });

  it("reconciles overlapping sets", () => {
    const shared = Array.from({ length: 200 }, (_, i) => ({
      timestamp: 1000 + i * 3,
      id: makeId(`shared-${i}`),
    }));
    const clientOnly = Array.from({ length: 30 }, (_, i) => ({
      timestamp: 1500 + i * 7,
      id: makeId(`client-${i}`),
    }));
    const serverOnly = Array.from({ length: 45 }, (_, i) => ({
      timestamp: 1700 + i * 5,
      id: makeId(`server-${i}`),
    }));

    assertSync([...shared, ...clientOnly], [...shared, ...serverOnly]);
  });

  it("reconciles disjoint sets", () => {
    const clientItems = Array.from({ length: 100 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`c-${i}`),
    }));
    const serverItems = Array.from({ length: 100 }, (_, i) => ({
      timestamp: 5000 + i,
      id: makeId(`s-${i}`),
    }));
    assertSync(clientItems, serverItems);
  });

  it("reconciles sets where many items share one timestamp", () => {
    // Exercises ID-prefix bounds (getMinimalBound with shared timestamp).
    const shared = Array.from({ length: 300 }, (_, i) => ({
      timestamp: 7777,
      id: makeId(`same-ts-${i}`),
    }));
    const clientOnly = Array.from({ length: 20 }, (_, i) => ({
      timestamp: 7777,
      id: makeId(`same-ts-client-${i}`),
    }));
    const serverOnly = Array.from({ length: 20 }, (_, i) => ({
      timestamp: 7777,
      id: makeId(`same-ts-server-${i}`),
    }));

    assertSync([...shared, ...clientOnly], [...shared, ...serverOnly]);
  });

  it("reconciles large sets with a server frame size limit", () => {
    const shared = Array.from({ length: 3000 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`big-shared-${i}`),
    }));
    const clientOnly = Array.from({ length: 200 }, (_, i) => ({
      timestamp: 2000 + i * 11,
      id: makeId(`big-client-${i}`),
    }));
    const serverOnly = Array.from({ length: 200 }, (_, i) => ({
      timestamp: 3000 + i * 13,
      id: makeId(`big-server-${i}`),
    }));

    const client = [...shared, ...clientOnly];
    const server = [...shared, ...serverOnly];
    const result = sync(client, server, { serverFrameLimit: 4096 });
    const expected = expectedDiff(client, server);
    assert.deepEqual([...result.haveIds].sort(), expected.have);
    assert.deepEqual([...result.needIds].sort(), expected.need);
    assert.ok(result.rounds > 1, "frame limit should force multiple rounds");
  });

  it("rejects a too-small frame size limit", () => {
    assert.throws(() => new Negentropy(makeVector([]), 100));
  });

  it("server replies with a bare version byte on unsupported version", () => {
    const server = new Negentropy(makeVector([]));
    const result = server.reconcile(new Uint8Array([0x62]));
    assert.ok(result.message !== null);
    assert.deepEqual([...result.message], [PROTOCOL_VERSION]);
  });

  it("initiator throws on unsupported version response", () => {
    const client = new Negentropy(makeVector([]));
    client.initiate();
    assert.throws(() => client.reconcile(new Uint8Array([0x62])));
  });

  it("throws on an invalid version byte", () => {
    const server = new Negentropy(makeVector([]));
    assert.throws(() => server.reconcile(new Uint8Array([0x41])));
  });

  it("throws on a truncated message", () => {
    const server = new Negentropy(
      makeVector([{ timestamp: 1, id: makeId("x") }]),
    );
    // Version byte + truncated bound.
    assert.throws(() =>
      server.reconcile(new Uint8Array([PROTOCOL_VERSION, 0x05, 0x20])),
    );
  });

  it("accumulates have/need across rounds without duplicates", () => {
    const clientItems = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`acc-c-${i}`),
    }));
    const serverItems = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: 1000 + i,
      id: makeId(`acc-s-${i}`),
    }));

    const result = sync(clientItems, serverItems, { serverFrameLimit: 4096 });
    assert.equal(new Set(result.haveIds).size, result.haveIds.length);
    assert.equal(new Set(result.needIds).size, result.needIds.length);
  });

  it("produces the exact wire bytes for a small initiate message", () => {
    // A set smaller than 32 items is sent as a single IdList range covering
    // the whole timestamp/ID space:
    //   0x61                     protocol version
    //   varint(0)                infinity timestamp
    //   varint(0)                empty ID prefix
    //   varint(2)                mode = IdList
    //   varint(2)                two IDs
    //   <id> <id>                IDs in storage order (timestamp ascending)
    const a = makeId("wire-a");
    const b = makeId("wire-b");

    const client = new Negentropy(
      makeVector([
        { timestamp: 100, id: a },
        { timestamp: 200, id: b },
      ]),
    );
    const message = client.initiate();

    assert.deepEqual([...message], [0x61, 0x00, 0x00, 0x02, 0x02, ...a, ...b]);
  });
});
