/**
 * NIP-85 Trusted Assertions publisher.
 *
 * Consumes engagement scores computed by {@link OpenSearchRelay.recomputeScores}
 * and publishes them as addressable NIP-85 assertion events:
 *
 * - Kind 30382: User stats (followers, post count)
 * - Kind 30383: Event stats (comments, reposts, reactions, zaps)
 * - Kind 30384: Addressable event stats (comments, reposts, reactions, zaps)
 * - Kind 30385: External identifier stats (comments, reactions, reposts)
 *
 * For kinds 30382 and 30383, scores come directly from `recomputeScores()`.
 * For kinds 30384 and 30385, this class maintains its own dirty sets
 * and queries OpenSearch to compute stats on flush.
 */

import type { NostrEvent, NostrSigner, NRelay } from "@nostrify/nostrify";
import type { Client } from "./opensearch-client.ts";
import type { EventScores } from "./opensearch.ts";

/** Options for constructing a {@link Nip85} instance. */
export interface Nip85Opts {
  /** OpenSearch client for direct aggregation queries. */
  client: Client;
  /** OpenSearch index name. */
  indexName: string;
  /** Relay instance for storing NIP-85 events. */
  relay: NRelay;
  /** Signer for signing NIP-85 events. */
  signer: NostrSigner;
  /** Optional callback to broadcast events to connected WebSocket subscribers. */
  broadcast?: (event: NostrEvent) => void;
}

/**
 * Publishes NIP-85 Trusted Assertion events from pre-computed engagement scores.
 */
export class Nip85 {
  private client: Client;
  private indexName: string;
  private relay: NRelay;
  private signer: NostrSigner;
  private broadcast?: (event: NostrEvent) => void;

  /** Addressable event addresses (`<kind>:<pubkey>:<d-tag>`) needing stats refresh. */
  private dirtyAddrs = new Set<string>();
  /** NIP-73 external identifiers needing stats refresh. */
  private dirtyIdentifiers = new Set<string>();

  constructor(opts: Nip85Opts) {
    this.client = opts.client;
    this.indexName = opts.indexName;
    this.relay = opts.relay;
    this.signer = opts.signer;
    this.broadcast = opts.broadcast;
  }

  /**
   * Publish kind 30382 user-stats assertion events for dirty profiles.
   *
   * Stats published:
   * - `followers` -- from pre-computed followers count
   * - `post_cnt`  -- computed via OpenSearch aggregation on kind 1 events
   */
  async publishUserStats(
    userScores: Map<string, { followers: number }>,
  ): Promise<void> {
    if (userScores.size === 0) return;

    const pubkeys = [...userScores.keys()];

    // Batch-compute post counts for all pubkeys in one aggregation query.
    const postCounts = await this.getPostCounts(pubkeys);

    for (const [pubkey, scores] of userScores) {
      const followers = scores.followers;
      const postCount = postCounts.get(pubkey) ?? 0;

      const tags: string[][] = [["d", pubkey]];
      if (followers > 0) tags.push(["followers", followers.toString()]);
      if (postCount > 0) tags.push(["post_cnt", postCount.toString()]);

      // Only publish if we have actual stats.
      if (tags.length <= 1) continue;

      const event = await this.signer.signEvent({
        kind: 30382,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      await this.relay.event(event);
      this.broadcast?.(event);
    }
  }

  /**
   * Publish kind 30383 event-stats assertion events for dirty events.
   *
   * Stats published:
   * - `comment_cnt`  -- comment_cnt from recomputeScores
   * - `repost_cnt`   -- repost_cnt from recomputeScores
   * - `reaction_cnt` -- reaction_cnt from recomputeScores
   * - `quote_cnt`    -- quote_cnt from recomputeScores
   * - `zap_cnt`      -- zap_cnt from recomputeScores
   * - `zap_amount`   -- zap_amount_msats converted to sats
   */
  async publishEventStats(
    eventScores: Map<string, EventScores>,
  ): Promise<void> {
    for (const [eventId, scores] of eventScores) {
      const zapAmount = Math.floor(scores.zap_amount_msats / 1000);

      const tags: string[][] = [["d", eventId]];
      if (scores.comment_cnt > 0)
        tags.push(["comment_cnt", scores.comment_cnt.toString()]);
      if (scores.repost_cnt > 0)
        tags.push(["repost_cnt", scores.repost_cnt.toString()]);
      if (scores.reaction_cnt > 0)
        tags.push(["reaction_cnt", scores.reaction_cnt.toString()]);
      if (scores.quote_cnt > 0)
        tags.push(["quote_cnt", scores.quote_cnt.toString()]);
      if (scores.zap_cnt > 0) tags.push(["zap_cnt", scores.zap_cnt.toString()]);
      if (zapAmount > 0) tags.push(["zap_amount", zapAmount.toString()]);

      // Only publish if we have actual stats.
      if (tags.length <= 1) continue;

      const event = await this.signer.signEvent({
        kind: 30383,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      await this.relay.event(event);
      this.broadcast?.(event);
    }
  }

  /**
   * Drain the dirty addr and identifier sets and return their contents.
   * Used by the main thread to collect dirty state after flush and forward
   * it to the background worker.
   */
  drainDirty(): { addrs: string[]; identifiers: string[] } {
    const addrs = [...this.dirtyAddrs];
    this.dirtyAddrs.clear();
    const identifiers = [...this.dirtyIdentifiers];
    this.dirtyIdentifiers.clear();
    return { addrs, identifiers };
  }

  /**
   * Accept dirty addressable event addresses for later stats computation.
   * Called by the {@link OpenSearchRelay.onDirtyAddrs} callback.
   */
  addDirtyAddrs(addrs: Set<string>): void {
    for (const addr of addrs) {
      this.dirtyAddrs.add(addr);
    }
  }

  /**
   * Flush dirty addressable event addresses: compute engagement stats via
   * OpenSearch aggregation and publish kind 30384 assertion events.
   *
   * Stats published per address:
   * - `comment_cnt`  -- kind 1 + 1111 referencing via `a` tag
   * - `repost_cnt`   -- kind 6 + 16 referencing via `a` tag
   * - `reaction_cnt` -- kind 7 referencing via `a` tag
   * - `quote_cnt`    -- kind 1 referencing via `q` tag (quote reposts)
   * - `zap_cnt`      -- kind 9735 count referencing via `a` tag
   * - `zap_amount`   -- sum of zap sats referencing via `a` tag
   */
  async flushAddrStats(): Promise<void> {
    // Atomically drain dirty set.
    const addrs = [...this.dirtyAddrs];
    this.dirtyAddrs.clear();

    if (addrs.length === 0) return;

    // Compute engagement stats for all dirty addresses in batch.
    const addrScores = await this.getAddrEngagement(addrs);

    for (const [addr, scores] of addrScores) {
      const zapAmount = Math.floor(scores.zap_amount_msats / 1000);

      const tags: string[][] = [["d", addr]];
      if (scores.comment_cnt > 0)
        tags.push(["comment_cnt", scores.comment_cnt.toString()]);
      if (scores.repost_cnt > 0)
        tags.push(["repost_cnt", scores.repost_cnt.toString()]);
      if (scores.reaction_cnt > 0)
        tags.push(["reaction_cnt", scores.reaction_cnt.toString()]);
      if (scores.quote_cnt > 0)
        tags.push(["quote_cnt", scores.quote_cnt.toString()]);
      if (scores.zap_cnt > 0) tags.push(["zap_cnt", scores.zap_cnt.toString()]);
      if (zapAmount > 0) tags.push(["zap_amount", zapAmount.toString()]);

      // Only publish if we have actual stats.
      if (tags.length <= 1) continue;

      const event = await this.signer.signEvent({
        kind: 30384,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      await this.relay.event(event);
      this.broadcast?.(event);
    }
  }

  /**
   * Accept dirty external identifiers for later stats computation.
   * Called by the {@link OpenSearchRelay.onDirtyIdentifiers} callback.
   */
  addDirtyIdentifiers(identifiers: Set<string>): void {
    for (const id of identifiers) {
      this.dirtyIdentifiers.add(id);
    }
  }

  /**
   * Flush dirty external identifiers: compute engagement stats via
   * OpenSearch aggregation and publish kind 30385 assertion events.
   *
   * Stats published per identifier:
   * - `comment_cnt`  -- kind 1 / 1111 referencing via `i` or `I` tag
   * - `reaction_cnt` -- kind 7 referencing via `i` or `I` tag
   * - `repost_cnt`   -- kind 16 / 17 referencing via `i` or `I` tag
   */
  async flushIdentifierStats(): Promise<void> {
    // Atomically drain dirty set.
    const identifiers = [...this.dirtyIdentifiers];
    this.dirtyIdentifiers.clear();

    if (identifiers.length === 0) return;

    // Compute stats for all dirty identifiers in batch.
    const identifierScores = await this.getIdentifierEngagement(identifiers);

    for (const [identifier, scores] of identifierScores) {
      const tags: string[][] = [["d", identifier]];
      if (scores.comment_cnt > 0)
        tags.push(["comment_cnt", scores.comment_cnt.toString()]);
      if (scores.reaction_cnt > 0)
        tags.push(["reaction_cnt", scores.reaction_cnt.toString()]);
      if (scores.repost_cnt > 0)
        tags.push(["repost_cnt", scores.repost_cnt.toString()]);

      // Only publish if we have actual stats.
      if (tags.length <= 1) continue;

      const event = await this.signer.signEvent({
        kind: 30385,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      await this.relay.event(event);
      this.broadcast?.(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Batch-compute post counts (kind 1 events) for a list of pubkeys
   * using an OpenSearch terms aggregation.
   */
  private async getPostCounts(pubkeys: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (pubkeys.length === 0) return result;

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { replaced: false } },
              { term: { kind: 1 } },
              { terms: { pubkey: pubkeys } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_author: {
            terms: {
              field: "pubkey",
              size: pubkeys.length,
              include: pubkeys,
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_author as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    for (const bucket of buckets) {
      result.set(bucket.key, bucket.doc_count);
    }

    return result;
  }

  /**
   * Compute engagement stats for addressable event addresses (`a` tag values)
   * using OpenSearch aggregations on `tags_map.a`.
   *
   * Runs two queries:
   * 1. Engagement aggregation (kinds 1/6/7/16/1111) grouped by `tags_map.a`
   *    with cardinality and per-kind sub-aggregations.
   * 2. Zap aggregation (kind 9735) grouped by `tags_map.a` with sum of amount_msats.
   */
  private async getAddrEngagement(
    addrs: string[],
  ): Promise<Map<string, EventScores>> {
    const scores = new Map<string, EventScores>();
    if (addrs.length === 0) return scores;

    // Initialize all addresses with zeros.
    for (const addr of addrs) {
      scores.set(addr, {
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_amount_msats: 0,
        zap_cnt: 0,
      });
    }

    // Query 1: Engagement (replies, reactions, reposts).
    const engagementResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { replaced: false } },
              { terms: { kind: [1, 6, 7, 16, 1111] } },
              { terms: { "tags_map.a": addrs } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_addr: {
            terms: {
              field: "tags_map.a",
              size: addrs.length,
              include: addrs,
            },
            aggs: {
              by_kind: {
                terms: { field: "kind", size: 10 },
              },
            },
          },
        },
      },
    });

    const engagementBuckets =
      (
        engagementResponse.body.aggregations?.by_addr as unknown as {
          buckets?: Array<{
            key: string;
            doc_count: number;
            by_kind?: {
              buckets?: Array<{ key: number; doc_count: number }>;
            };
          }>;
        }
      )?.buckets || [];

    for (const bucket of engagementBuckets) {
      const s = scores.get(bucket.key);
      if (!s) continue;

      for (const kb of bucket.by_kind?.buckets || []) {
        switch (kb.key) {
          case 1:
          case 1111:
            s.comment_cnt += kb.doc_count;
            break;
          case 7:
            s.reaction_cnt += kb.doc_count;
            break;
          case 6:
          case 16:
            s.repost_cnt += kb.doc_count;
            break;
        }
      }
    }

    // Query 2: Zaps (kind 9735).
    const zapResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { replaced: false } },
              { term: { kind: 9735 } },
              { terms: { "tags_map.a": addrs } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_addr: {
            terms: {
              field: "tags_map.a",
              size: addrs.length,
              include: addrs,
            },
            aggs: {
              total_msats: {
                sum: { field: "amount_msats" },
              },
            },
          },
        },
      },
    });

    const zapBuckets =
      (
        zapResponse.body.aggregations?.by_addr as unknown as {
          buckets?: Array<{
            key: string;
            doc_count: number;
            total_msats?: { value: number };
          }>;
        }
      )?.buckets || [];

    for (const bucket of zapBuckets) {
      const s = scores.get(bucket.key);
      if (s) {
        s.zap_amount_msats = bucket.total_msats?.value ?? 0;
        s.zap_cnt = bucket.doc_count;
      }
    }

    return scores;
  }

  /**
   * Compute engagement stats for external identifiers (`i` and `I` tag values)
   * using OpenSearch aggregations.
   *
   * Queries both `tags_map.i` and `tags_map.I` (kind 1111 uses uppercase `I`
   * for inclusive identifier references) and merges the results.
   *
   * Engagement mapping:
   * - kind 1, 1111 → comment_count
   * - kind 7       → reaction_cnt
   * - kind 16, 17  → repost_cnt
   */
  private async getIdentifierEngagement(
    identifiers: string[],
  ): Promise<
    Map<
      string,
      { comment_cnt: number; reaction_cnt: number; repost_cnt: number }
    >
  > {
    const scores = new Map<
      string,
      { comment_cnt: number; reaction_cnt: number; repost_cnt: number }
    >();
    if (identifiers.length === 0) return scores;

    // Initialize all identifiers with zeros.
    for (const id of identifiers) {
      scores.set(id, { comment_cnt: 0, reaction_cnt: 0, repost_cnt: 0 });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { replaced: false } },
              { terms: { kind: [1, 7, 16, 17, 1111] } },
            ],
            should: [
              { terms: { "tags_map.i": identifiers } },
              { terms: { "tags_map.I": identifiers } },
            ],
            minimum_should_match: 1,
          },
        },
        size: 0,
        aggs: {
          by_i: {
            terms: {
              field: "tags_map.i",
              size: identifiers.length,
              include: identifiers,
            },
            aggs: {
              by_kind: {
                terms: { field: "kind", size: 10 },
              },
            },
          },
          by_I: {
            terms: {
              field: "tags_map.I",
              size: identifiers.length,
              include: identifiers,
            },
            aggs: {
              by_kind: {
                terms: { field: "kind", size: 10 },
              },
            },
          },
        },
      },
    });

    type KindBucket = { key: number; doc_count: number };
    type IdentifierBucket = {
      key: string;
      doc_count: number;
      by_kind?: { buckets?: KindBucket[] };
    };
    type AggResult = { buckets?: IdentifierBucket[] };

    const iBuckets =
      (response.body.aggregations?.by_i as unknown as AggResult)?.buckets || [];
    const IBuckets =
      (response.body.aggregations?.by_I as unknown as AggResult)?.buckets || [];

    // Accumulate counts from both tag fields.
    for (const buckets of [iBuckets, IBuckets]) {
      for (const bucket of buckets) {
        const s = scores.get(bucket.key);
        if (!s) continue;

        for (const kb of bucket.by_kind?.buckets || []) {
          switch (kb.key) {
            case 1:
            case 1111:
              s.comment_cnt += kb.doc_count;
              break;
            case 7:
              s.reaction_cnt += kb.doc_count;
              break;
            case 16:
            case 17:
              s.repost_cnt += kb.doc_count;
              break;
          }
        }
      }
    }

    return scores;
  }
}
