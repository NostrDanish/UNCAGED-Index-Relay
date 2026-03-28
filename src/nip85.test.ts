import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent, NostrSigner, NRelay } from "@nostrify/nostrify";
import type { Client } from "./opensearch-client.ts";

import { Nip85 } from "./nip85.ts";
import type { EventScores } from "./opensearch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock NostrSigner that produces deterministic unsigned events. */
function createMockSigner(): NostrSigner {
  return {
    getPublicKey: async () =>
      "aaaa000000000000000000000000000000000000000000000000000000000000",
    signEvent: async (template) => ({
      ...template,
      id: `id_${template.kind}_${template.tags.find((t) => t[0] === "d")?.[1] ?? "unknown"}`,
      pubkey:
        "aaaa000000000000000000000000000000000000000000000000000000000000",
      sig: "mocksig",
    }),
  } as NostrSigner;
}

/** Create a mock NRelay that captures published events. */
function createMockRelay(): NRelay & { events: NostrEvent[] } {
  const events: NostrEvent[] = [];
  return {
    events,
    event: async (event: NostrEvent) => {
      events.push(event);
    },
    // Unused methods for NRelay compliance.
    query: async () => [],
    req: async function* () {},
  } as unknown as NRelay & { events: NostrEvent[] };
}

/**
 * Minimal mock document stored in the mock OpenSearch client.
 */
interface MockDocument {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  tags_map: Record<string, string[]>;
  deleted: boolean;
  replaced: boolean;
  amount_msats?: number;
}

function buildTagsMap(tags: string[][]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const tag of tags) {
    if (tag.length >= 2) {
      const [name, ...values] = tag;
      if (!map[name]) map[name] = [];
      map[name].push(...values);
    }
  }
  return map;
}

/**
 * Create a mock OpenSearch client for NIP-85 tests.
 *
 * Supports the aggregation queries used by:
 * - `getPostCounts()` -- terms aggregation on `pubkey` filtered to kind 1
 * - `getAddrEngagement()` -- terms on `tags_map.a` for engagement + zaps
 */
function createMockClient() {
  const documents: MockDocument[] = [];

  function matchesClause(
    doc: MockDocument,
    clause: Record<string, unknown>,
  ): boolean {
    if (clause.term) {
      for (const [field, expected] of Object.entries(
        clause.term as Record<string, unknown>,
      )) {
        if ((doc as unknown as Record<string, unknown>)[field] !== expected)
          return false;
      }
    }
    if (clause.terms) {
      for (const [field, allowed] of Object.entries(
        clause.terms as Record<string, unknown[]>,
      )) {
        if (field.startsWith("tags_map.")) {
          const tagName = field.slice("tags_map.".length);
          const tagValues = doc.tags_map[tagName] ?? [];
          if (!tagValues.some((v) => (allowed as string[]).includes(v)))
            return false;
        } else {
          const val = (doc as unknown as Record<string, unknown>)[field];
          if (!(allowed as unknown[]).includes(val)) return false;
        }
      }
    }
    return true;
  }

  function matchesBool(
    doc: MockDocument,
    bool: {
      must?: Array<Record<string, unknown>>;
      should?: Array<Record<string, unknown>>;
      minimum_should_match?: number;
    },
  ): boolean {
    // All must clauses must match.
    if (bool.must) {
      for (const clause of bool.must) {
        if (!matchesClause(doc, clause)) return false;
      }
    }
    // At least minimum_should_match (default 0) should clauses must match.
    if (bool.should && bool.should.length > 0) {
      const minMatch = bool.minimum_should_match ?? 0;
      let matched = 0;
      for (const clause of bool.should) {
        if (matchesClause(doc, clause)) matched++;
      }
      if (matched < minMatch) return false;
    }
    return true;
  }

  const client = {
    search: async ({
      body,
    }: {
      body: Record<string, unknown>;
      index?: string;
    }) => {
      const query = body.query as {
        bool: {
          must?: Array<Record<string, unknown>>;
          should?: Array<Record<string, unknown>>;
          minimum_should_match?: number;
        };
      };
      const aggs = body.aggs as
        | Record<string, Record<string, unknown>>
        | undefined;

      const matched = documents.filter((doc) => matchesBool(doc, query.bool));

      if (!aggs) {
        return { body: { hits: { hits: [] }, aggregations: {} } };
      }

      const aggregations: Record<string, unknown> = {};

      for (const [aggName, aggDef] of Object.entries(aggs)) {
        const termsDef = aggDef as {
          terms: { field: string; size: number; include?: string[] };
          aggs?: Record<
            string,
            {
              terms?: { field: string; size: number };
              sum?: { field: string };
            }
          >;
        };

        const field = termsDef.terms.field;
        const include = termsDef.terms.include;

        // Group documents by the aggregation field value.
        const bucketMap = new Map<
          string,
          { docs: MockDocument[]; count: number }
        >();

        for (const doc of matched) {
          let values: string[];
          if (field.startsWith("tags_map.")) {
            const tagName = field.slice("tags_map.".length);
            values = doc.tags_map[tagName] ?? [];
          } else if (field === "pubkey") {
            values = [doc.pubkey];
          } else {
            continue;
          }

          for (const val of values) {
            if (include && !include.includes(val)) continue;
            const existing = bucketMap.get(val);
            if (existing) {
              existing.docs.push(doc);
              existing.count++;
            } else {
              bucketMap.set(val, { docs: [doc], count: 1 });
            }
          }
        }

        // Build bucket results with sub-aggregations.
        const buckets = [...bucketMap.entries()]
          .sort(([, a], [, b]) => b.count - a.count)
          .slice(0, termsDef.terms.size)
          .map(([key, { docs, count }]) => {
            const bucket: Record<string, unknown> = {
              key,
              doc_count: count,
            };

            if (termsDef.aggs) {
              for (const [subName, subDef] of Object.entries(termsDef.aggs)) {
                if (subDef.terms) {
                  // Sub-terms aggregation (e.g. by_kind).
                  const subField = subDef.terms.field;
                  const subBucketMap = new Map<string | number, number>();
                  for (const doc of docs) {
                    const val = (doc as unknown as Record<string, unknown>)[
                      subField
                    ];
                    if (val !== undefined) {
                      subBucketMap.set(
                        val as string | number,
                        (subBucketMap.get(val as string | number) ?? 0) + 1,
                      );
                    }
                  }
                  bucket[subName] = {
                    buckets: [...subBucketMap.entries()].map(([k, c]) => ({
                      key: k,
                      doc_count: c,
                    })),
                  };
                }

                if (subDef.sum) {
                  // Sum aggregation (e.g. total_msats).
                  const sumField = subDef.sum.field;
                  let total = 0;
                  for (const doc of docs) {
                    const val = (doc as unknown as Record<string, number>)[
                      sumField
                    ];
                    if (typeof val === "number") total += val;
                  }
                  bucket[subName] = { value: total };
                }
              }
            }

            return bucket;
          });

        aggregations[aggName] = { buckets };
      }

      return { body: { hits: { hits: [] }, aggregations } };
    },
  } as unknown as Client;

  return { client, documents };
}

function makeDoc(
  overrides: Partial<MockDocument> & {
    kind: number;
    pubkey: string;
    tags: string[][];
  },
): MockDocument {
  return {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    pubkey: overrides.pubkey,
    kind: overrides.kind,
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    tags: overrides.tags,
    tags_map: buildTagsMap(overrides.tags),
    deleted: overrides.deleted ?? false,
    replaced: overrides.replaced ?? false,
    ...(overrides.amount_msats !== undefined && {
      amount_msats: overrides.amount_msats,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Nip85", () => {
  describe("publishUserStats", () => {
    it("publishes kind 30382 with followers and post_cnt", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();
      const pubkey =
        "bbbb000000000000000000000000000000000000000000000000000000000000";

      // Add some kind 1 events for the pubkey.
      for (let i = 0; i < 5; i++) {
        documents.push(makeDoc({ kind: 1, pubkey, tags: [] }));
      }

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const userScores = new Map([[pubkey, { followers: 42 }]]);
      await nip85.publishUserStats(userScores);

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.equal(event.kind, 30382);
      assert.deepEqual(
        event.tags.find((t) => t[0] === "d"),
        ["d", pubkey],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "followers"),
        ["followers", "42"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "post_cnt"),
        ["post_cnt", "5"],
      );
    });

    it("skips publishing when all stats are zero", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();
      const pubkey =
        "cccc000000000000000000000000000000000000000000000000000000000000";

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const userScores = new Map([[pubkey, { followers: 0 }]]);
      await nip85.publishUserStats(userScores);

      assert.equal(relay.events.length, 0);
    });

    it("does nothing for empty map", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      await nip85.publishUserStats(new Map());
      assert.equal(relay.events.length, 0);
    });
  });

  describe("publishEventStats", () => {
    it("publishes kind 30383 with all engagement stats", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const eventId =
        "dddd000000000000000000000000000000000000000000000000000000000000";
      const scores: EventScores = {
        comment_cnt: 10,
        reaction_cnt: 20,
        repost_cnt: 3,
        quote_cnt: 2,
        zap_cnt: 5,
        zap_amount_msats: 100_000,
      };

      await nip85.publishEventStats(new Map([[eventId, scores]]));

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.equal(event.kind, 30383);
      assert.deepEqual(
        event.tags.find((t) => t[0] === "d"),
        ["d", eventId],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "10"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "reaction_cnt"),
        ["reaction_cnt", "20"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "repost_cnt"),
        ["repost_cnt", "3"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "quote_cnt"),
        ["quote_cnt", "2"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "zap_cnt"),
        ["zap_cnt", "5"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "zap_amount"),
        ["zap_amount", "100"],
      );
    });

    it("converts zap_amount_msats to sats correctly", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const eventId =
        "eeee000000000000000000000000000000000000000000000000000000000000";
      const scores: EventScores = {
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_cnt: 1,
        zap_amount_msats: 21_500, // 21.5 sats, floors to 21
      };

      await nip85.publishEventStats(new Map([[eventId, scores]]));

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.deepEqual(
        event.tags.find((t) => t[0] === "zap_amount"),
        ["zap_amount", "21"],
      );
    });

    it("skips publishing when all stats are zero", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const eventId =
        "ffff000000000000000000000000000000000000000000000000000000000000";
      const scores: EventScores = {
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_cnt: 0,
        zap_amount_msats: 0,
      };

      await nip85.publishEventStats(new Map([[eventId, scores]]));
      assert.equal(relay.events.length, 0);
    });

    it("omits zero-valued tags", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      const eventId =
        "1111000000000000000000000000000000000000000000000000000000000000";
      const scores: EventScores = {
        comment_cnt: 5,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_cnt: 0,
        zap_amount_msats: 0,
      };

      await nip85.publishEventStats(new Map([[eventId, scores]]));

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      // Should have d + comment_cnt only
      assert.equal(event.tags.length, 2);
      assert.ok(event.tags.find((t) => t[0] === "comment_cnt"));
      assert.ok(!event.tags.find((t) => t[0] === "reaction_cnt"));
      assert.ok(!event.tags.find((t) => t[0] === "zap_cnt"));
    });
  });

  describe("flushAddrStats", () => {
    it("publishes kind 30384 with engagement stats for dirty addresses", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const addr = "30023:pubkey123:my-article";

      // Add replies (kind 1) referencing the address.
      for (let i = 0; i < 3; i++) {
        documents.push(
          makeDoc({
            kind: 1,
            pubkey: `author_${i}`,
            tags: [["a", addr]],
          }),
        );
      }

      // Add reactions (kind 7) referencing the address.
      for (let i = 0; i < 7; i++) {
        documents.push(
          makeDoc({
            kind: 7,
            pubkey: `reactor_${i}`,
            tags: [["a", addr]],
          }),
        );
      }

      // Add a repost (kind 6).
      documents.push(
        makeDoc({
          kind: 6,
          pubkey: "reposter_0",
          tags: [["a", addr]],
        }),
      );

      // Add zaps (kind 9735).
      documents.push(
        makeDoc({
          kind: 9735,
          pubkey: "zapper_0",
          tags: [["a", addr]],
          amount_msats: 50_000,
        }),
      );
      documents.push(
        makeDoc({
          kind: 9735,
          pubkey: "zapper_1",
          tags: [["a", addr]],
          amount_msats: 30_000,
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyAddrs(new Set([addr]));
      await nip85.flushAddrStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.equal(event.kind, 30384);
      assert.deepEqual(
        event.tags.find((t) => t[0] === "d"),
        ["d", addr],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "3"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "reaction_cnt"),
        ["reaction_cnt", "7"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "repost_cnt"),
        ["repost_cnt", "1"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "zap_cnt"),
        ["zap_cnt", "2"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "zap_amount"),
        ["zap_amount", "80"],
      );
    });

    it("drains the dirty set after flush", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const addr = "30023:pubkey:slug";
      documents.push(
        makeDoc({
          kind: 7,
          pubkey: "reactor",
          tags: [["a", addr]],
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyAddrs(new Set([addr]));
      await nip85.flushAddrStats();
      assert.equal(relay.events.length, 1);

      // Second flush should be a no-op (dirty set drained).
      await nip85.flushAddrStats();
      assert.equal(relay.events.length, 1);
    });

    it("does nothing when no dirty addresses", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      await nip85.flushAddrStats();
      assert.equal(relay.events.length, 0);
    });

    it("skips addresses with no engagement", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyAddrs(new Set(["30023:nobody:nothing"]));
      await nip85.flushAddrStats();
      assert.equal(relay.events.length, 0);
    });
  });

  describe("flushIdentifierStats", () => {
    it("publishes kind 30385 with comment and reaction counts", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "https://example.com/article";

      // Add comments (kind 1111) referencing the identifier.
      for (let i = 0; i < 4; i++) {
        documents.push(
          makeDoc({
            kind: 1111,
            pubkey: `commenter_${i}`,
            tags: [["i", identifier]],
          }),
        );
      }

      // Add reactions (kind 7) referencing the identifier.
      for (let i = 0; i < 2; i++) {
        documents.push(
          makeDoc({
            kind: 7,
            pubkey: `reactor_${i}`,
            tags: [["i", identifier]],
          }),
        );
      }

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.equal(event.kind, 30385);
      assert.deepEqual(
        event.tags.find((t) => t[0] === "d"),
        ["d", identifier],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "4"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "reaction_cnt"),
        ["reaction_cnt", "2"],
      );
    });

    it("processes iso3166: identifiers like any other", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      // Add a comment referencing an iso3166 identifier.
      documents.push(
        makeDoc({
          kind: 1111,
          pubkey: "commenter",
          tags: [["i", "iso3166:VE"]],
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set(["iso3166:VE"]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.equal(event.kind, 30385);
      assert.deepEqual(
        event.tags.find((t) => t[0] === "d"),
        ["d", "iso3166:VE"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "1"],
      );
    });

    it("counts kind 1 as comment_cnt", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "https://example.com/page";

      // Add kind 1 notes referencing the identifier.
      for (let i = 0; i < 3; i++) {
        documents.push(
          makeDoc({
            kind: 1,
            pubkey: `author_${i}`,
            tags: [["i", identifier]],
          }),
        );
      }

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "3"],
      );
    });

    it("counts kind 16 and 17 as repost_cnt", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "https://example.com/reposted";

      // Add kind 16 generic reposts.
      documents.push(
        makeDoc({
          kind: 16,
          pubkey: "reposter_0",
          tags: [["i", identifier]],
        }),
      );
      documents.push(
        makeDoc({
          kind: 16,
          pubkey: "reposter_1",
          tags: [["i", identifier]],
        }),
      );

      // Add kind 17 repost.
      documents.push(
        makeDoc({
          kind: 17,
          pubkey: "reposter_2",
          tags: [["i", identifier]],
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.deepEqual(
        event.tags.find((t) => t[0] === "repost_cnt"),
        ["repost_cnt", "3"],
      );
      // No comment or reaction tags expected.
      assert.equal(
        event.tags.find((t) => t[0] === "comment_cnt"),
        undefined,
      );
      assert.equal(
        event.tags.find((t) => t[0] === "reaction_cnt"),
        undefined,
      );
    });

    it("counts engagement from uppercase I tags", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "isbn:9780765382030";

      // Kind 1111 with uppercase I tag (inclusive identifier reference).
      documents.push(
        makeDoc({
          kind: 1111,
          pubkey: "commenter_0",
          tags: [["I", identifier]],
        }),
      );

      // Kind 1111 with lowercase i tag.
      documents.push(
        makeDoc({
          kind: 1111,
          pubkey: "commenter_1",
          tags: [["i", identifier]],
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "2"],
      );
    });

    it("combines all engagement types in one event", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "https://example.com/full";

      // comment (kind 1)
      documents.push(
        makeDoc({ kind: 1, pubkey: "a1", tags: [["i", identifier]] }),
      );
      // comment (kind 1111)
      documents.push(
        makeDoc({ kind: 1111, pubkey: "a2", tags: [["i", identifier]] }),
      );
      // reaction (kind 7)
      documents.push(
        makeDoc({ kind: 7, pubkey: "a3", tags: [["i", identifier]] }),
      );
      // repost (kind 16)
      documents.push(
        makeDoc({ kind: 16, pubkey: "a4", tags: [["i", identifier]] }),
      );
      // repost (kind 17)
      documents.push(
        makeDoc({ kind: 17, pubkey: "a5", tags: [["i", identifier]] }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();

      assert.equal(relay.events.length, 1);
      const event = relay.events[0];
      assert.deepEqual(
        event.tags.find((t) => t[0] === "comment_cnt"),
        ["comment_cnt", "2"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "reaction_cnt"),
        ["reaction_cnt", "1"],
      );
      assert.deepEqual(
        event.tags.find((t) => t[0] === "repost_cnt"),
        ["repost_cnt", "2"],
      );
    });

    it("drains the dirty set after flush", async () => {
      const { client, documents } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const identifier = "isbn:9780765382030";
      documents.push(
        makeDoc({
          kind: 1111,
          pubkey: "commenter",
          tags: [["i", identifier]],
        }),
      );

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set([identifier]));
      await nip85.flushIdentifierStats();
      assert.equal(relay.events.length, 1);

      // Second flush should be a no-op.
      await nip85.flushIdentifierStats();
      assert.equal(relay.events.length, 1);
    });

    it("skips identifiers with no engagement", async () => {
      const { client } = createMockClient();
      const relay = createMockRelay();
      const signer = createMockSigner();

      const nip85 = new Nip85({
        client,
        indexName: "test",
        relay,
        signer,
      });

      nip85.addDirtyIdentifiers(new Set(["https://example.com/nothing"]));
      await nip85.flushIdentifierStats();
      assert.equal(relay.events.length, 0);
    });
  });
});
