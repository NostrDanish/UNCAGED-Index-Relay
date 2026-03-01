/**
 * Community Stats module.
 *
 * Computes per-country community statistics by querying the relay,
 * then publishes a single kind 30385 event per country (keyed by
 * `iso3166:<code>`). All data lives in tags with empty content,
 * following NIP-85 convention.
 *
 * Aggregate counts come from relay COUNT queries. Leaderboards (top posters,
 * trending hashtags, top zapped contributors, top donors, top actions)
 * are computed from fetched events, with time-windowed variants for each.
 *
 * Designed to run on a periodic schedule within the relay process.
 */

import type {
  NostrEvent,
  NostrFilter,
  NostrSigner,
  NRelay,
} from "@nostrify/nostrify";
import type { Client } from "@opensearch-project/opensearch";
import countries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json";
import { iso31662 } from "iso-3166";

countries.registerLocale(en);

const validSubdivisionCodes = new Set(iso31662.map((s) => s.code));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOWS = [
  { key: "7d", seconds: 7 * 24 * 60 * 60 },
  { key: "30d", seconds: 30 * 24 * 60 * 60 },
  { key: "90d", seconds: 90 * 24 * 60 * 60 },
] as const;

const TIMEFRAMES = ["7d", "30d", "90d", "all"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/** App-specific hashtags to exclude from trending. */
const APP_HASHTAGS = new Set([
  "agora-action",
  "pathos-challenge",
  "pathos",
  "activism",
]);

/** Maximum number of entries per leaderboard. */
const LEADERBOARD_LIMIT = 10;

/** Pagination batch size for fetching events. */
const FETCH_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A relay that supports NIP-45 COUNT queries. */
type CountRelay = NRelay & {
  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate?: boolean }>;
};

/** Options for constructing a {@link CommunityStats} instance. */
export interface CommunityStatsOpts {
  /** Relay used for COUNT queries (should support Ditto search extensions). */
  relay: CountRelay;
  /** OpenSearch client for direct aggregation queries. */
  client: Client;
  /** OpenSearch index name. */
  indexName: string;
  /** Signer used to sign published events. */
  signer: NostrSigner;
  /** How often (ms) to run the community stats pipeline. Default: 3600000 (1 hour). */
  intervalMs?: number;
  /** Number of countries to process concurrently. Default: 5. */
  concurrency?: number;
}

interface CountryStats {
  countryCode: string;
  tags: string[][];
}

export interface ZapAggregation {
  zapAmount: number;
  zapCnt: number;
  donors: Map<string, { totalSats: number; zapCount: number }>;
  contributors: Map<string, { totalSats: number; zapCount: number }>;
}

// ---------------------------------------------------------------------------
// Zap helpers
// ---------------------------------------------------------------------------

/**
 * Extract sats from a BOLT11 invoice string.
 * Fallback for zap receipts that have a bolt11 tag but no amount tag.
 * @internal Exported for testing.
 */
export function extractAmountFromBolt11(bolt11: string): number {
  try {
    const match = bolt11.match(/^ln(bc|tb)(\d+)([munp]?)/i);
    if (!match) return 0;
    const amount = parseInt(match[2], 10);
    const multiplier = match[3]?.toLowerCase() || "";
    let sats = 0;
    switch (multiplier) {
      case "m":
        sats = amount * 100_000;
        break;
      case "u":
        sats = amount * 100;
        break;
      case "n":
        sats = amount * 0.1;
        break;
      case "p":
        sats = amount * 0.0001;
        break;
      default:
        sats = amount * 100_000_000;
        break;
    }
    return Math.floor(sats);
  } catch {
    return 0;
  }
}

/**
 * Extract sats from a zap receipt event. Tries amount tag first, then bolt11.
 * @internal Exported for testing.
 */
export function extractZapSats(zap: NostrEvent): number {
  const amountTag = zap.tags.find(([n]) => n === "amount");
  if (amountTag?.[1]) {
    const sats = Math.floor(parseInt(amountTag[1], 10) / 1000);
    if (sats > 0) return sats;
  }
  const bolt11Tag = zap.tags.find(([n]) => n === "bolt11");
  if (bolt11Tag?.[1]) {
    return extractAmountFromBolt11(bolt11Tag[1]);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Count posts per author.
 * @internal Exported for testing.
 */
export function countByAuthor(posts: NostrEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    counts.set(post.pubkey, (counts.get(post.pubkey) || 0) + 1);
  }
  return counts;
}

/**
 * Count hashtag usage, excluding app-specific tags.
 * @internal Exported for testing.
 */
export function countHashtags(posts: NostrEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.tags) {
      if (tag[0] === "t" && tag[1] && !APP_HASHTAGS.has(tag[1].toLowerCase())) {
        counts.set(tag[1], (counts.get(tag[1]) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Aggregate zap receipts into donor/contributor maps.
 *
 * Contributors are identified by the `p` (lowercase) tag -- the zap recipient.
 * Donors are identified by the `P` (uppercase) tag -- the zap sender.
 */
export function aggregateZaps(zaps: NostrEvent[]): ZapAggregation {
  const donors = new Map<string, { totalSats: number; zapCount: number }>();
  const contributors = new Map<
    string,
    { totalSats: number; zapCount: number }
  >();
  let zapAmount = 0;
  let zapCnt = 0;

  for (const zap of zaps) {
    const amountSats = extractZapSats(zap);
    if (amountSats <= 0) continue;

    zapAmount += amountSats;
    zapCnt += 1;

    // Donor: P tag (uppercase) = sender
    const sender = zap.tags.find(([n]) => n === "P")?.[1];
    if (sender) {
      const existing = donors.get(sender) || { totalSats: 0, zapCount: 0 };
      existing.totalSats += amountSats;
      existing.zapCount += 1;
      donors.set(sender, existing);
    }

    // Contributor: p tag (lowercase) = recipient
    const recipient = zap.tags.find(([n]) => n === "p")?.[1];
    if (recipient) {
      const existing = contributors.get(recipient) || {
        totalSats: 0,
        zapCount: 0,
      };
      existing.totalSats += amountSats;
      existing.zapCount += 1;
      contributors.set(recipient, existing);
    }
  }

  return { zapAmount, zapCnt, donors, contributors };
}

/**
 * Aggregate zap receipts for action submissions, per-action, per-timeframe.
 */
/** @internal Exported for testing. */
export function aggregateActionZaps(
  allZapReceipts: NostrEvent[],
  actionSubmissions: Map<string, NostrEvent[]>,
  now: number,
): Map<string, Record<Timeframe, { zapAmount: number; zapCnt: number }>> {
  const result = new Map<
    string,
    Record<Timeframe, { zapAmount: number; zapCnt: number }>
  >();

  const submissionToAction = new Map<string, string>();
  const submissionTimestamps = new Map<string, number>();
  for (const [aTag, submissions] of actionSubmissions) {
    for (const sub of submissions) {
      submissionToAction.set(sub.id, aTag);
      submissionTimestamps.set(sub.id, sub.created_at);
    }
  }

  if (submissionToAction.size === 0) return result;

  const emptyTfRecord = (): Record<
    Timeframe,
    { zapAmount: number; zapCnt: number }
  > => ({
    "7d": { zapAmount: 0, zapCnt: 0 },
    "30d": { zapAmount: 0, zapCnt: 0 },
    "90d": { zapAmount: 0, zapCnt: 0 },
    all: { zapAmount: 0, zapCnt: 0 },
  });

  for (const zap of allZapReceipts) {
    const amountSats = extractZapSats(zap);
    if (amountSats <= 0) continue;

    const zappedEventId = zap.tags.find(([n]: string[]) => n === "e")?.[1];
    if (!zappedEventId) continue;

    const aTag = submissionToAction.get(zappedEventId);
    if (!aTag) continue;

    const subTs = submissionTimestamps.get(zappedEventId);
    if (subTs === undefined) continue;

    if (!result.has(aTag)) {
      result.set(aTag, emptyTfRecord());
    }
    const record = result.get(aTag);
    if (!record) continue;

    record.all.zapAmount += amountSats;
    record.all.zapCnt += 1;
    for (const w of WINDOWS) {
      if (subTs >= now - w.seconds) {
        record[w.key].zapAmount += amountSats;
        record[w.key].zapCnt += 1;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tag generation helpers
// ---------------------------------------------------------------------------

/**
 * Generate windowed tags from a Record<Timeframe, number>.
 * Produces: ["base", all], ["base_7d", 7d], ["base_30d", 30d], ["base_90d", 90d]
 */
/** @internal Exported for testing. */
export function windowedTags(
  base: string,
  values: Record<Timeframe, number>,
): string[][] {
  return [
    [base, String(values.all)],
    ...WINDOWS.map((w) => [`${base}_${w.key}`, String(values[w.key])]),
  ];
}

// ---------------------------------------------------------------------------
// Global aggregation helpers
// ---------------------------------------------------------------------------

/** Extract a numeric tag value from a tag list. */
function getTagNum(tags: string[][], name: string): number {
  const tag = tags.find(([n]) => n === name);
  return tag?.[1] ? parseInt(tag[1], 10) || 0 : 0;
}

/** Sum a windowed tag across all country tag sets. */
function sumTagWindowed(
  base: string,
  allTagSets: string[][][],
): Record<Timeframe, number> {
  const sumTag = (name: string) =>
    allTagSets.reduce((sum, tags) => sum + getTagNum(tags, name), 0);
  const result: Record<string, number> = { all: sumTag(base) };
  for (const w of WINDOWS) {
    result[w.key] = sumTag(`${base}_${w.key}`);
  }
  return result as Record<Timeframe, number>;
}

/**
 * Merge leaderboard entries across countries.
 * Sums the primary metric (value at `metricIndex`) for entries with the same key
 * (value at index 1), then returns the top N sorted by that metric.
 */
/** @internal Exported for testing. */
export function mergeLeaderboard(
  allTags: string[][][],
  tagName: string,
  metricIndex: number,
): string[][] {
  const merged = new Map<string, string[]>();
  const metricSums = new Map<string, number>();
  const bestIndividual = new Map<string, number>();

  for (const tags of allTags) {
    for (const tag of tags.filter(([n]) => n === tagName)) {
      const key = tag[1];
      if (!key) continue;
      const metric = parseInt(tag[metricIndex], 10) || 0;

      metricSums.set(key, (metricSums.get(key) || 0) + metric);

      if (metric > (bestIndividual.get(key) || 0)) {
        bestIndividual.set(key, metric);
        merged.set(key, [...tag]);
      }
    }
  }

  for (const [key, tag] of merged) {
    tag[metricIndex] = String(metricSums.get(key) || 0);
  }

  return Array.from(merged.values())
    .sort(
      (a, b) =>
        (parseInt(b[metricIndex], 10) || 0) -
        (parseInt(a[metricIndex], 10) || 0),
    )
    .slice(0, LEADERBOARD_LIMIT);
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Process items with limited concurrency.
 * Runs up to `concurrency` items at a time, calling `fn` for each.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// CommunityStats class
// ---------------------------------------------------------------------------

/**
 * Computes and publishes per-country and global community statistics
 * as NIP-85 kind 30385 events. Runs on a periodic schedule within the
 * relay process.
 */
export class CommunityStats {
  private relay: CountRelay;
  private client: Client;
  private indexName: string;
  private signer: NostrSigner;
  private intervalMs: number;
  private concurrency: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: CommunityStatsOpts) {
    this.relay = opts.relay;
    this.client = opts.client;
    this.indexName = opts.indexName;
    this.signer = opts.signer;
    this.intervalMs = opts.intervalMs ?? 3_600_000; // 1 hour
    this.concurrency = opts.concurrency ?? 5;
  }

  /** Start the periodic community stats timer. Runs immediately then on interval. */
  start(): void {
    if (this.timer) return;
    // Run immediately, then on interval
    this.run().catch((err) => console.error("Community stats run error:", err));
    this.timer = setInterval(() => {
      this.run().catch((err) =>
        console.error("Community stats run error:", err),
      );
    }, this.intervalMs);
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run the full community stats pipeline once. */
  async run(): Promise<void> {
    if (this.running) {
      console.log("Community stats: skipping run, previous still in progress");
      return;
    }
    this.running = true;

    try {
      console.log("Community stats: starting run...");
      const startTime = Date.now();

      const geoCodes = Object.keys(countries.getAlpha2Codes());

      // Phase 1: Quick-filter codes with activity
      const activeCodes: string[] = [];
      let skipped = 0;

      await mapConcurrent(
        geoCodes,
        this.concurrency * 2,
        async (code: string) => {
          try {
            const active = await this.hasActivity(code);
            if (active) {
              activeCodes.push(code);
            } else {
              skipped++;
            }
          } catch (err) {
            console.error(
              `Community stats: error checking activity for ${code}:`,
              err,
            );
            skipped++;
          }
        },
      );

      // Phase 1.5: Discover subdivisions with activity
      try {
        const subdivisions = await this.discoverSubdivisions(activeCodes);
        if (subdivisions.length > 0) {
          console.log(
            `Community stats: found ${subdivisions.length} active subdivisions: ${subdivisions.join(", ")}`,
          );
          activeCodes.push(...subdivisions);
        }
      } catch (err) {
        console.error("Community stats: error discovering subdivisions:", err);
      }

      console.log(
        `Community stats: ${activeCodes.length} active codes, ${skipped} empty`,
      );

      // Phase 2: Process active codes concurrently
      const allCountryStats: CountryStats[] = [];
      let processed = 0;
      let errors = 0;

      await mapConcurrent(
        activeCodes,
        this.concurrency,
        async (code: string) => {
          try {
            const stats = await this.computeCountryStats(code);
            await this.publishStats(stats);
            allCountryStats.push(stats);
            processed++;

            const commentCnt =
              stats.tags.find(([n]) => n === "comment_cnt")?.[1] ?? "0";
            const authorCnt =
              stats.tags.find(([n]) => n === "author_cnt")?.[1] ?? "0";
            console.log(
              `Community stats: ${code} comments=${commentCnt} authors=${authorCnt}`,
            );
          } catch (err) {
            console.error(`Community stats: error processing ${code}:`, err);
            errors++;
          }
        },
      );

      // Phase 3: Compute and publish global (ZZ) stats
      if (allCountryStats.length > 0) {
        try {
          const globalStats = await this.computeGlobalStats(allCountryStats);
          await this.publishStats(globalStats);
          console.log(
            `Community stats: published global (ZZ) stats for ${allCountryStats.length} countries`,
          );
        } catch (err) {
          console.error("Community stats: error computing global stats:", err);
          errors++;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `Community stats: done in ${elapsed}s. Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors}`,
      );
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Relay helpers
  // ---------------------------------------------------------------------------

  /** COUNT query with timeout. Returns 0 on failure. */
  private async relayCount(filter: NostrFilter): Promise<number> {
    try {
      const signal = AbortSignal.timeout(15_000);
      const result = await this.relay.count([filter], { signal });
      return result.count;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch all events matching a filter using `until`-based pagination.
   * Deduplicates by event ID across pages.
   */
  private async fetchAllPaginated(
    baseFilter: NostrFilter,
  ): Promise<NostrEvent[]> {
    const seen = new Map<string, NostrEvent>();
    let until: number | undefined;

    for (;;) {
      const filter: NostrFilter = {
        ...baseFilter,
        limit: FETCH_PAGE_SIZE,
      };
      if (until !== undefined) {
        filter.until = until;
      }

      const signal = AbortSignal.timeout(15_000);
      let page: NostrEvent[];
      try {
        page = await this.relay.query([filter], { signal });
      } catch {
        break;
      }
      if (page.length === 0) break;

      let newEvents = 0;
      for (const event of page) {
        if (!seen.has(event.id)) {
          seen.set(event.id, event);
          newEvents++;
        }
      }

      if (newEvents === 0) break;
      if (page.length < FETCH_PAGE_SIZE) break;

      const oldest = page.reduce(
        (min, e) => (e.created_at < min ? e.created_at : min),
        page[0].created_at,
      );
      until = oldest - 1;
    }

    return Array.from(seen.values());
  }

  // ---------------------------------------------------------------------------
  // Activity detection
  // ---------------------------------------------------------------------------

  /** Quick check: does this country have any activity at all? */
  private async hasActivity(countryCode: string): Promise<boolean> {
    const iTag = `iso3166:${countryCode}`;
    const count = await this.relayCount({
      kinds: [1111],
      "#i": [iTag],
    });
    return count > 0;
  }

  /**
   * Discover subdivisions with activity by scanning recent posts
   * for subdivision-level `i` tags (e.g. `iso3166:VE-A`).
   */
  private async discoverSubdivisions(
    activeCountryCodes: string[],
  ): Promise<string[]> {
    const recentPosts = await this.fetchAllPaginated({
      kinds: [1111],
      since: Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60,
    });

    const subdivisionCodes = new Set<string>();
    const activeSet = new Set(activeCountryCodes);

    for (const post of recentPosts) {
      for (const tag of post.tags) {
        if (tag[0] === "i" && tag[1]?.startsWith("iso3166:")) {
          const code = tag[1].slice(8);
          if (
            code.includes("-") &&
            validSubdivisionCodes.has(code) &&
            !activeSet.has(code)
          ) {
            subdivisionCodes.add(code);
          }
        }
      }
    }

    return Array.from(subdivisionCodes);
  }

  // ---------------------------------------------------------------------------
  // Windowed count helper
  // ---------------------------------------------------------------------------

  /** Run a COUNT query for all-time + each time window in parallel. */
  private async countWindowed(
    baseFilter: NostrFilter,
    now: number,
  ): Promise<Record<Timeframe, number>> {
    const promises = [
      this.relayCount(baseFilter),
      ...WINDOWS.map((w) =>
        this.relayCount({ ...baseFilter, since: now - w.seconds }),
      ),
    ];
    const [all, ...windowed] = await Promise.all(promises);
    const result: Record<string, number> = { all };
    WINDOWS.forEach((w, i) => {
      result[w.key] = windowed[i];
    });
    return result as Record<Timeframe, number>;
  }

  // ---------------------------------------------------------------------------
  // Per-country stats
  // ---------------------------------------------------------------------------

  /** Compute stats for a single country. */
  private async computeCountryStats(
    countryCode: string,
  ): Promise<CountryStats> {
    const iTag = `iso3166:${countryCode}`;
    const now = Math.floor(Date.now() / 1000);

    // Aggregate COUNT queries (efficient -- single count per query)
    const [authorCnts, commentCnts] = await Promise.all([
      this.countWindowed(
        {
          search: "distinct:author",
          kinds: [1111],
          "#i": [iTag],
        } as NostrFilter,
        now,
      ),
      this.countWindowed({ kinds: [1111], "#i": [iTag] }, now),
    ]);

    // Use OpenSearch aggregations for leaderboards (top posters, hashtags,
    // zaps) instead of fetching all events into memory.
    const allTimeframes: Array<{ tf: Timeframe; since?: number }> = [
      { tf: "all" },
      ...WINDOWS.map((w) => ({
        tf: w.key as Timeframe,
        since: now - w.seconds,
      })),
    ];

    // Run all timeframe aggregations in parallel.
    const [posterResults, hashtagResults, zapResults] = await Promise.all([
      // Top posters per timeframe
      Promise.all(
        allTimeframes.map(({ since }) =>
          this.aggTopPosters(iTag, LEADERBOARD_LIMIT, since),
        ),
      ),
      // Trending hashtags per timeframe
      Promise.all(
        allTimeframes.map(({ since }) =>
          this.aggTopHashtags(iTag, LEADERBOARD_LIMIT, since),
        ),
      ),
      // Zap stats per timeframe (totals + top contributors + top donors)
      Promise.all(
        allTimeframes.map(({ since }) =>
          this.aggZapStats(iTag, LEADERBOARD_LIMIT, since),
        ),
      ),
    ]);

    // Build windowed zap totals
    const zapAmountByTf: Record<Timeframe, number> = {
      all: 0,
      "7d": 0,
      "30d": 0,
      "90d": 0,
    };
    const zapCntByTf: Record<Timeframe, number> = {
      all: 0,
      "7d": 0,
      "30d": 0,
      "90d": 0,
    };
    for (let i = 0; i < allTimeframes.length; i++) {
      const tf = allTimeframes[i].tf;
      zapAmountByTf[tf] = zapResults[i].totalSats;
      zapCntByTf[tf] = zapResults[i].totalCount;
    }

    // Fetch actions for this country (both new and legacy schemas).
    // Actions are a small dataset — fetching full events is fine.
    const [newActions, legacyActions] = await Promise.all([
      this.fetchAllPaginated({ kinds: [36639], "#i": [iTag] }),
      this.fetchAllPaginated({ kinds: [36639], "#t": ["pathos-challenge"] }),
    ]);

    const legacyFiltered = legacyActions.filter((c) => {
      const loc = c.tags.find(([n]) => n === "location")?.[1];
      return loc?.toUpperCase() === countryCode;
    });

    const actionMap = new Map<string, NostrEvent>();
    for (const c of [...newActions, ...legacyFiltered]) {
      actionMap.set(c.id, c);
    }
    const allActions = Array.from(actionMap.values());

    // Extract action info
    interface ActionInfo {
      aTag: string;
      title: string;
      bounty: number;
    }
    const actionInfos: ActionInfo[] = [];
    for (const action of allActions) {
      const dTag = action.tags.find(([n]) => n === "d")?.[1];
      const title = action.tags.find(([n]) => n === "title")?.[1];
      const bounty = action.tags.find(([n]) => n === "bounty")?.[1];
      if (!dTag || !title) continue;
      actionInfos.push({
        aTag: `36639:${action.pubkey}:${dTag}`,
        title,
        bounty: parseInt(bounty || "0", 10),
      });
    }

    // Count submissions per action per timeframe
    const actionSubmissionCounts = new Map<string, Record<string, number>>();
    const actionSubmissionEvents = new Map<string, NostrEvent[]>();

    await Promise.all(
      actionInfos.map(async (action) => {
        const [subsAll, subs7d, subs30d, subs90d] = await Promise.all([
          this.relayCount({ kinds: [1111], "#A": [action.aTag] }),
          this.relayCount({
            kinds: [1111],
            "#A": [action.aTag],
            since: now - WINDOWS[0].seconds,
          }),
          this.relayCount({
            kinds: [1111],
            "#A": [action.aTag],
            since: now - WINDOWS[1].seconds,
          }),
          this.relayCount({
            kinds: [1111],
            "#A": [action.aTag],
            since: now - WINDOWS[2].seconds,
          }),
        ]);
        if (subsAll > 0) {
          actionSubmissionCounts.set(action.aTag, {
            all: subsAll,
            "7d": subs7d,
            "30d": subs30d,
            "90d": subs90d,
          });

          const submissions = await this.fetchAllPaginated({
            kinds: [1111],
            "#A": [action.aTag],
          });
          actionSubmissionEvents.set(action.aTag, submissions);
        }
      }),
    );

    // Aggregate zaps for actions. Still needs full zap events for attribution
    // to specific submissions. Fetch only zaps for the known submission IDs.
    const allSubmissionIds = new Set<string>();
    for (const [, submissions] of actionSubmissionEvents) {
      for (const sub of submissions) {
        allSubmissionIds.add(sub.id);
      }
    }
    let actionZapReceipts: NostrEvent[] = [];
    if (allSubmissionIds.size > 0) {
      actionZapReceipts = await this.fetchAllPaginated({
        kinds: [9735],
        "#e": [...allSubmissionIds],
      });
    }
    const actionZapAggs = aggregateActionZaps(
      actionZapReceipts,
      actionSubmissionEvents,
      now,
    );

    // Sum total submissions across ALL actions per timeframe
    const submissionCnts: Record<Timeframe, number> = {
      all: 0,
      "7d": 0,
      "30d": 0,
      "90d": 0,
    };
    for (const tfCounts of actionSubmissionCounts.values()) {
      for (const tf of TIMEFRAMES) {
        submissionCnts[tf] += tfCounts[tf] ?? 0;
      }
    }

    // Build tags
    const tags: string[][] = [
      ["d", `iso3166:${countryCode}`],
      ...windowedTags("comment_cnt", commentCnts),
      ...windowedTags("author_cnt", authorCnts),
      ...windowedTags("zap_amount", zapAmountByTf),
      ...windowedTags("zap_cnt", zapCntByTf),
      ...windowedTags("submission_cnt", submissionCnts),
      ["alt", `Community statistics for ${countryCode}`],
    ];

    // Leaderboard tags per timeframe
    for (let i = 0; i < allTimeframes.length; i++) {
      const tf = allTimeframes[i].tf;
      const suffix = tf === "all" ? "" : `_${tf}`;

      // top_poster (from aggregation)
      const posterMap = posterResults[i];
      for (const [pubkey, count] of posterMap) {
        tags.push([`top_poster${suffix}`, pubkey, String(count)]);
      }

      // trending_hashtag (from aggregation, already excludes app hashtags)
      const hashtagMap = hashtagResults[i];
      for (const [hashtag, count] of hashtagMap) {
        tags.push([`trending_hashtag${suffix}`, hashtag, String(count)]);
      }

      // top_zapped (from aggregation)
      const zap = zapResults[i];
      for (const c of zap.topContributors) {
        const postCount = posterMap.get(c.pubkey) || 0;
        const avgSats =
          c.zapCount > 0 ? Math.floor(c.totalSats / c.zapCount) : 0;
        tags.push([
          `top_zapped${suffix}`,
          c.pubkey,
          String(c.totalSats),
          String(postCount),
          String(avgSats),
          String(c.zapCount),
        ]);
      }

      // top_donor (from aggregation)
      for (const d of zap.topDonors) {
        tags.push([
          `top_donor${suffix}`,
          d.pubkey,
          String(d.totalSats),
          String(d.zapCount),
        ]);
      }

      // top_action (unchanged -- uses COUNT data)
      const tfActions = actionInfos
        .map((a) => ({
          ...a,
          submissions: actionSubmissionCounts.get(a.aTag)?.[tf] ?? 0,
          zapAmount: actionZapAggs.get(a.aTag)?.[tf]?.zapAmount ?? 0,
        }))
        .filter((a) => a.submissions > 0)
        .sort((a, b) => b.submissions - a.submissions)
        .slice(0, LEADERBOARD_LIMIT);
      for (const a of tfActions) {
        tags.push([
          `top_action${suffix}`,
          a.aTag,
          a.title,
          String(a.submissions),
          String(a.bounty),
          String(a.zapAmount),
        ]);
      }
    }

    return { countryCode, tags };
  }

  // ---------------------------------------------------------------------------
  // OpenSearch aggregation helpers
  // ---------------------------------------------------------------------------

  /** Get top posters (by post count) for a country via OpenSearch aggregation. */
  private async aggTopPosters(
    iTag: string,
    limit: number,
    since?: number,
  ): Promise<Map<string, number>> {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } },
      { term: { kind: 1111 } },
      { terms: { "tags_map.i": [iTag] } },
    ];
    if (since !== undefined) {
      must.push({ range: { created_at: { gte: since } } });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: { bool: { must } },
        size: 0,
        aggs: {
          by_author: {
            terms: { field: "pubkey", size: limit },
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

    const result = new Map<string, number>();
    for (const bucket of buckets) {
      result.set(bucket.key, bucket.doc_count);
    }
    return result;
  }

  /** Get top hashtags for a country via OpenSearch aggregation. */
  private async aggTopHashtags(
    iTag: string,
    limit: number,
    since?: number,
  ): Promise<Map<string, number>> {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } },
      { term: { kind: 1111 } },
      { terms: { "tags_map.i": [iTag] } },
    ];
    if (since !== undefined) {
      must.push({ range: { created_at: { gte: since } } });
    }

    // Over-fetch to allow filtering out app hashtags.
    const fetchSize = limit + APP_HASHTAGS.size;

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: { bool: { must } },
        size: 0,
        aggs: {
          by_hashtag: {
            terms: { field: "tags_map.t", size: fetchSize },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_hashtag as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    const result = new Map<string, number>();
    for (const bucket of buckets) {
      if (APP_HASHTAGS.has(bucket.key.toLowerCase())) continue;
      if (result.size >= limit) break;
      result.set(bucket.key, bucket.doc_count);
    }
    return result;
  }

  /** Aggregated zap stats for a country. */
  private async aggZapStats(
    iTag: string,
    limit: number,
    since?: number,
  ): Promise<{
    totalSats: number;
    totalCount: number;
    topContributors: Array<{
      pubkey: string;
      totalSats: number;
      zapCount: number;
    }>;
    topDonors: Array<{
      pubkey: string;
      totalSats: number;
      zapCount: number;
    }>;
  }> {
    // First, get the pubkeys of contributors for this country.
    // Contributors are authors of kind 1111 posts tagged with this country.
    const contributorPubkeys = await this.aggContributorPubkeys(iTag);
    if (contributorPubkeys.length === 0) {
      return {
        totalSats: 0,
        totalCount: 0,
        topContributors: [],
        topDonors: [],
      };
    }

    // Query kind 9735 zaps where `p` tag matches contributor pubkeys.
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } },
      { term: { kind: 9735 } },
      { terms: { "tags_map.p": contributorPubkeys } },
    ];
    if (since !== undefined) {
      must.push({ range: { created_at: { gte: since } } });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: { bool: { must } },
        size: 0,
        aggs: {
          total_msats: { sum: { field: "amount_msats" } },
          // Top contributors: group by p tag (recipient)
          by_recipient: {
            terms: { field: "tags_map.p", size: limit },
            aggs: {
              total_msats: { sum: { field: "amount_msats" } },
            },
          },
          // Top donors: group by P tag (sender)
          by_sender: {
            terms: { field: "tags_map.P", size: limit },
            aggs: {
              total_msats: { sum: { field: "amount_msats" } },
            },
          },
        },
      },
    });

    const totalMsats =
      (response.body.aggregations?.total_msats as { value?: number })?.value ??
      0;
    const hitsTotal = response.body.hits?.total;
    const totalCount =
      typeof hitsTotal === "number"
        ? hitsTotal
        : ((hitsTotal as { value?: number })?.value ?? 0);

    const recipientBuckets =
      (
        response.body.aggregations?.by_recipient as unknown as {
          buckets?: Array<{
            key: string;
            doc_count: number;
            total_msats?: { value: number };
          }>;
        }
      )?.buckets || [];

    const senderBuckets =
      (
        response.body.aggregations?.by_sender as unknown as {
          buckets?: Array<{
            key: string;
            doc_count: number;
            total_msats?: { value: number };
          }>;
        }
      )?.buckets || [];

    return {
      totalSats: Math.floor(totalMsats / 1000),
      totalCount,
      topContributors: recipientBuckets.map((b) => ({
        pubkey: b.key,
        totalSats: Math.floor((b.total_msats?.value ?? 0) / 1000),
        zapCount: b.doc_count,
      })),
      topDonors: senderBuckets.map((b) => ({
        pubkey: b.key,
        totalSats: Math.floor((b.total_msats?.value ?? 0) / 1000),
        zapCount: b.doc_count,
      })),
    };
  }

  /** Get distinct contributor pubkeys for a country (authors of kind 1111 posts). */
  private async aggContributorPubkeys(iTag: string): Promise<string[]> {
    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { kind: 1111 } },
              { terms: { "tags_map.i": [iTag] } },
            ],
          },
        },
        size: 0,
        aggs: {
          authors: {
            terms: { field: "pubkey", size: 10_000 },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.authors as unknown as {
          buckets?: Array<{ key: string }>;
        }
      )?.buckets || [];

    return buckets.map((b) => b.key);
  }

  // ---------------------------------------------------------------------------
  // Global stats
  // ---------------------------------------------------------------------------

  /**
   * Aggregate all country stats into a single global (ZZ) event.
   * Aggregate counts are queried directly (not summed) for proper deduplication.
   * Leaderboards are merged from per-country data.
   */
  private async computeGlobalStats(
    allCountryStats: CountryStats[],
  ): Promise<CountryStats> {
    const now = Math.floor(Date.now() / 1000);

    const [authorCnts, commentCnts] = await Promise.all([
      this.countWindowed(
        { search: "distinct:author", kinds: [1111] } as NostrFilter,
        now,
      ),
      this.countWindowed({ kinds: [1111] }, now),
    ]);

    const allTagSets = allCountryStats.map((s) => s.tags);

    const tags: string[][] = [
      ["d", "iso3166:ZZ"],
      ...windowedTags("comment_cnt", commentCnts),
      ...windowedTags("author_cnt", authorCnts),
      ...windowedTags("zap_amount", sumTagWindowed("zap_amount", allTagSets)),
      ...windowedTags("zap_cnt", sumTagWindowed("zap_cnt", allTagSets)),
      ...windowedTags(
        "submission_cnt",
        sumTagWindowed("submission_cnt", allTagSets),
      ),
      ["alt", "Global community statistics"],
    ];

    // Merge leaderboards across countries for each timeframe
    for (const tf of TIMEFRAMES) {
      const suffix = tf === "all" ? "" : `_${tf}`;

      for (const tag of mergeLeaderboard(
        allTagSets,
        `top_poster${suffix}`,
        2,
      )) {
        tags.push(tag);
      }
      for (const tag of mergeLeaderboard(
        allTagSets,
        `trending_hashtag${suffix}`,
        2,
      )) {
        tags.push(tag);
      }
      for (const tag of mergeLeaderboard(
        allTagSets,
        `top_zapped${suffix}`,
        2,
      )) {
        tags.push(tag);
      }
      for (const tag of mergeLeaderboard(allTagSets, `top_donor${suffix}`, 2)) {
        tags.push(tag);
      }
      for (const tag of mergeLeaderboard(
        allTagSets,
        `top_action${suffix}`,
        3,
      )) {
        tags.push(tag);
      }
    }

    // Track which countries contributed
    for (const cs of allCountryStats) {
      tags.push(["country", cs.countryCode]);
    }

    return { countryCode: "ZZ", tags };
  }

  // ---------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------

  /** Sign and publish a community stats event. */
  private async publishStats(stats: CountryStats): Promise<void> {
    const event = await this.signer.signEvent({
      kind: 30385,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: stats.tags,
    });

    await this.relay.event(event, { signal: AbortSignal.timeout(10_000) });
  }
}
