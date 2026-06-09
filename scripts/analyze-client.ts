/**
 * Analyze the users of a given Nostr client on the relay.
 *
 * Identifies every distinct pubkey that has published at least one event
 * carrying the client's NIP-89 `client` tag (matched on the human-readable
 * name stored in `tags_map.client`, i.e. the tag's second value), then
 * reports cohort / engagement / churn statistics:
 *
 *   - Total distinct users
 *   - Active vs inactive split (by recency of their most recent event)
 *   - Recency distribution (last-seen buckets)
 *   - Engagement depth (event counts, one-post users, same-day churners)
 *   - Join-month cohorts (first event per user)
 *   - Top event kinds posted with this client
 *
 * Multiple client names can be passed and are analyzed together as a single
 * client. This is useful for clients that publish under more than one tag
 * (e.g. "Primal Android" and "Primal Web").
 *
 * Optionally writes a per-user TSV (pubkey, first, last, count) for further
 * analysis (e.g. splitting into active/inactive lists, encoding to npub).
 *
 * Usage:
 *   bun run scripts/analyze-client.ts <client-name>... [options]
 *
 * Examples:
 *   bun run scripts/analyze-client.ts Ditto
 *   bun run scripts/analyze-client.ts "Damus" --active-days 7
 *   bun run scripts/analyze-client.ts Amethyst --out /tmp/amethyst-users.tsv
 *   bun run scripts/analyze-client.ts "Primal Android" "Primal Web"
 *
 * Options:
 *   --active-days <n>   Days since last event to count as "active" (default: 30)
 *   --out <path>        Write per-user TSV to this path (pubkey<TAB>first<TAB>last<TAB>count)
 *   --kinds <n>         Number of top event kinds to show (default: 15)
 */

import { writeFile } from "node:fs/promises";
import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

const PAGE_SIZE = 1000;
const SECONDS_PER_DAY = 86_400;

/** Per-user activity aggregated from the user's events with this client. */
interface UserStats {
  pubkey: string;
  first: number;
  last: number;
  count: number;
}

interface Options {
  clients: string[];
  activeDays: number;
  out: string | undefined;
  topKinds: number;
}

/** Parse CLI arguments. Positional args are client name(s). */
function parseArgs(argv: string[]): Options {
  const clients: string[] = [];
  let activeDays = 30;
  let out: string | undefined;
  let topKinds = 15;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--active-days":
        activeDays = Number(argv[++i]);
        break;
      case "--out":
        out = argv[++i];
        break;
      case "--kinds":
        topKinds = Number(argv[++i]);
        break;
      default:
        clients.push(arg);
    }
  }

  if (clients.length === 0) {
    console.error(
      "Usage: bun run scripts/analyze-client.ts <client-name>... [--active-days <n>] [--out <path>] [--kinds <n>]",
    );
    console.error("Example: bun run scripts/analyze-client.ts Ditto");
    console.error(
      'Example: bun run scripts/analyze-client.ts "Primal Android" "Primal Web"',
    );
    process.exit(1);
  }

  if (!Number.isFinite(activeDays) || activeDays <= 0) {
    console.error("--active-days must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(topKinds) || topKinds <= 0) {
    console.error("--kinds must be a positive number");
    process.exit(1);
  }

  return { clients, activeDays, out, topKinds };
}

/**
 * Match events for these client(s). The relay indexes the human-readable
 * client name (second value of the NIP-89 `client` tag) into
 * `tags_map.client`, which is a `keyword` so it matches exactly. Multiple
 * names are matched with a `terms` query and treated as one combined client.
 */
function clientQuery(clients: string[]): Record<string, unknown> {
  return { terms: { "tags_map.client": clients } };
}

/**
 * Collect per-user activity (first/last event time and total event count)
 * for every user of the client, paginating with a composite aggregation.
 */
async function collectUsers(
  client: OpenSearchClient,
  index: string,
  clientNames: string[],
): Promise<UserStats[]> {
  const users: UserStats[] = [];
  let after: Record<string, string> | undefined;

  while (true) {
    const composite: Record<string, unknown> = {
      size: PAGE_SIZE,
      sources: [{ pubkey: { terms: { field: "pubkey" } } }],
    };
    if (after) composite.after = after;

    const response = await client.search({
      index,
      body: {
        size: 0,
        query: clientQuery(clientNames),
        aggs: {
          users: {
            composite,
            aggs: {
              first: { min: { field: "created_at" } },
              last: { max: { field: "created_at" } },
              cnt: { value_count: { field: "created_at" } },
            },
          },
        },
      },
    });

    const agg = response.body.aggregations?.users as unknown as {
      buckets: Array<{
        key: { pubkey: string };
        first: { value: number | null };
        last: { value: number | null };
        cnt: { value: number };
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = agg?.buckets ?? [];
    if (buckets.length === 0) break;

    for (const b of buckets) {
      if (b.first.value === null || b.last.value === null) continue;
      users.push({
        pubkey: b.key.pubkey,
        first: Math.round(b.first.value),
        last: Math.round(b.last.value),
        count: b.cnt.value,
      });
    }

    after = agg.after_key;
    if (!after) break;
  }

  return users;
}

/** Top event kinds posted with this client, with counts. */
async function topKinds(
  client: OpenSearchClient,
  index: string,
  clientNames: string[],
  size: number,
): Promise<Array<{ kind: number; count: number }>> {
  const response = await client.search({
    index,
    body: {
      size: 0,
      query: clientQuery(clientNames),
      aggs: { kinds: { terms: { field: "kind", size } } },
    },
  });

  const agg = response.body.aggregations?.kinds as unknown as {
    buckets: Array<{ key: number; doc_count: number }>;
  };

  return (agg?.buckets ?? []).map((b) => ({ kind: b.key, count: b.doc_count }));
}

/** Age in days of a timestamp relative to now (clamps future timestamps to 0). */
function ageDays(ts: number, now: number): number {
  return (now - Math.min(ts, now)) / SECONDS_PER_DAY;
}

/** Median of a numeric array (returns 0 for empty input). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Format a unix timestamp as a YYYY-MM month string (UTC). */
function monthKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 7);
}

/** Print engagement-depth statistics for a group of users. */
function printEngagement(label: string, group: UserStats[]): void {
  const n = group.length;
  if (n === 0) {
    console.log(`== ${label} (n=0) ==`);
    return;
  }
  const counts = group.map((u) => u.count);
  const lifespans = group.map((u) => (u.last - u.first) / SECONDS_PER_DAY);
  const onePost = group.filter((u) => u.count === 1).length;
  const sameDay = lifespans.filter((l) => l < 1).length;
  const totalEvents = counts.reduce((a, b) => a + b, 0);

  console.log(`== ${label} (n=${n}) ==`);
  console.log(`  median event count: ${median(counts)}`);
  console.log(`  mean event count:   ${(totalEvents / n).toFixed(1)}`);
  console.log(
    `  one-post-only users: ${onePost} (${Math.round((100 * onePost) / n)}%)`,
  );
  console.log(
    `  median lifespan (days first->last): ${median(lifespans).toFixed(1)}`,
  );
  console.log(
    `  same-day churners (lifespan <1d): ${sameDay} (${Math.round((100 * sameDay) / n)}%)`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  const index = config.opensearchIndex;
  console.log(`Client analysis: "${opts.clients.join('", "')}"`);
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${index}`);
  console.log(`Active threshold: last event within ${opts.activeDays} days\n`);

  const clientOptions: ClientOptions = { node: config.opensearchNode };
  if (config.opensearchUsername && config.opensearchPassword) {
    clientOptions.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }
  const client = new OpenSearchClient(clientOptions);

  try {
    const now = Math.floor(Date.now() / 1000);

    console.log("Collecting users...");
    const users = await collectUsers(client, index, opts.clients);

    if (users.length === 0) {
      console.log(
        `\nNo users found for client "${opts.clients.join('", "')}".`,
      );
      console.log(
        "Check the exact client name (case-sensitive). Example names: Ditto, Damus, Amethyst, Primal.",
      );
      return;
    }

    const active = users.filter((u) => ageDays(u.last, now) <= opts.activeDays);
    const inactive = users.filter(
      (u) => ageDays(u.last, now) > opts.activeDays,
    );

    // Overview
    console.log(`\n=== Overview ===`);
    console.log(`Total distinct users: ${users.length}`);
    console.log(
      `Active (<=${opts.activeDays}d):   ${active.length} (${Math.round((100 * active.length) / users.length)}%)`,
    );
    console.log(
      `Inactive (>${opts.activeDays}d):  ${inactive.length} (${Math.round((100 * inactive.length) / users.length)}%)`,
    );

    // Recency distribution (last-seen buckets)
    const bucketDefs: Array<[string, number]> = [
      ["<=7d", 7],
      ["<=30d", 30],
      ["<=90d", 90],
      ["<=180d", 180],
      ["<=365d", 365],
      [">365d", Number.POSITIVE_INFINITY],
    ];
    const recency = new Map(bucketDefs.map(([l]) => [l, 0]));
    let future = 0;
    for (const u of users) {
      if (u.last > now + 3600) future++;
      const a = ageDays(u.last, now);
      for (const [label, limit] of bucketDefs) {
        if (a <= limit) {
          recency.set(label, (recency.get(label) ?? 0) + 1);
          break;
        }
      }
    }
    console.log(`\n=== Recency distribution (by last event) ===`);
    if (future > 0) {
      console.log(
        `  (note: ${future} users have future-dated events, clamped)`,
      );
    }
    for (const [label] of bucketDefs) {
      console.log(`  ${label}: ${recency.get(label)}`);
    }

    // Engagement depth
    console.log(`\n=== Engagement depth ===`);
    printEngagement("INACTIVE", inactive);
    printEngagement("ACTIVE", active);

    // Join-month cohorts
    console.log(`\n=== Join cohorts (first event month) ===`);
    const joinAll = new Map<string, number>();
    const joinInactive = new Map<string, number>();
    for (const u of users) {
      const m = monthKey(u.first);
      joinAll.set(m, (joinAll.get(m) ?? 0) + 1);
    }
    for (const u of inactive) {
      const m = monthKey(u.first);
      joinInactive.set(m, (joinInactive.get(m) ?? 0) + 1);
    }
    console.log("  month     all   (inactive)");
    for (const m of [...joinAll.keys()].sort()) {
      const all = joinAll.get(m) ?? 0;
      const inact = joinInactive.get(m) ?? 0;
      console.log(
        `  ${m}   ${String(all).padStart(5)}   ${String(inact).padStart(5)}`,
      );
    }

    // Top event kinds
    console.log(`\n=== Top ${opts.topKinds} event kinds (this client) ===`);
    const kinds = await topKinds(client, index, opts.clients, opts.topKinds);
    const kindTotal = kinds.reduce((a, k) => a + k.count, 0);
    for (const k of kinds) {
      const pct =
        kindTotal > 0 ? ((100 * k.count) / kindTotal).toFixed(1) : "0.0";
      console.log(`  kind ${k.kind}: ${k.count} (${pct}%)`);
    }

    // Optional per-user TSV
    if (opts.out) {
      const lines = ["pubkey\tfirst\tlast\tcount"];
      for (const u of [...users].sort((a, b) => b.last - a.last)) {
        lines.push(`${u.pubkey}\t${u.first}\t${u.last}\t${u.count}`);
      }
      await writeFile(opts.out, `${lines.join("\n")}\n`);
      console.log(
        `\nWrote per-user data to ${opts.out} (${users.length} rows)`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("\nClient analysis failed:", error);
  process.exit(1);
});
