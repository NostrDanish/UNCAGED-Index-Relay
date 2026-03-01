import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "@nostrify/nostrify";

import {
  aggregateActionZaps,
  aggregateZaps,
  countByAuthor,
  countHashtags,
  extractAmountFromBolt11,
  extractZapSats,
  mergeLeaderboard,
  windowedTags,
} from "./community-stats.ts";

// ---------------------------------------------------------------------------
// Helpers to build mock events
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<NostrEvent> & { pubkey: string; tags: string[][] },
): NostrEvent {
  return {
    id: overrides.id ?? `id_${Math.random().toString(36).slice(2)}`,
    pubkey: overrides.pubkey,
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 1,
    tags: overrides.tags,
    content: overrides.content ?? "",
    sig: overrides.sig ?? "mocksig",
  };
}

// ---------------------------------------------------------------------------
// extractAmountFromBolt11
// ---------------------------------------------------------------------------

describe("extractAmountFromBolt11", () => {
  it("parses milli-BTC (m) amounts", () => {
    // lnbc1m = 1 mBTC = 100,000 sats
    assert.equal(extractAmountFromBolt11("lnbc1m1ptest"), 100_000);
  });

  it("parses micro-BTC (u) amounts", () => {
    // lnbc500u = 500 uBTC = 50,000 sats
    assert.equal(extractAmountFromBolt11("lnbc500u1ptest"), 50_000);
  });

  it("parses nano-BTC (n) amounts", () => {
    // lnbc10000n = 10000 nBTC = 1000 sats
    assert.equal(extractAmountFromBolt11("lnbc10000n1ptest"), 1000);
  });

  it("parses pico-BTC (p) amounts", () => {
    // lnbc10000000p = 10_000_000 pBTC = 1000 sats
    assert.equal(extractAmountFromBolt11("lnbc10000000p1ptest"), 1000);
  });

  it("parses BTC amounts (no multiplier)", () => {
    // lnbc1 followed by non-multiplier char -> matched as 1 BTC
    // Note: the regex captures digits greedily so "lnbc1" + no [munp] = default multiplier
    assert.equal(extractAmountFromBolt11("lnbc1"), 100_000_000);
  });

  it("handles testnet (lntb)", () => {
    assert.equal(extractAmountFromBolt11("lntb500u1ptest"), 50_000);
  });

  it("returns 0 for invalid invoice", () => {
    assert.equal(extractAmountFromBolt11("not-an-invoice"), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(extractAmountFromBolt11(""), 0);
  });

  it("floors fractional sats", () => {
    // lnbc1n = 1 nBTC = 0.1 sats -> floors to 0
    assert.equal(extractAmountFromBolt11("lnbc1n1ptest"), 0);
  });
});

// ---------------------------------------------------------------------------
// extractZapSats
// ---------------------------------------------------------------------------

describe("extractZapSats", () => {
  it("extracts from amount tag (msats to sats)", () => {
    const zap = makeEvent({
      pubkey: "zapper",
      tags: [["amount", "50000"]],
    });
    assert.equal(extractZapSats(zap), 50); // 50000 msats = 50 sats
  });

  it("falls back to bolt11 tag when amount tag is absent", () => {
    const zap = makeEvent({
      pubkey: "zapper",
      tags: [["bolt11", "lnbc500u1ptest"]],
    });
    assert.equal(extractZapSats(zap), 50_000);
  });

  it("prefers amount tag over bolt11", () => {
    const zap = makeEvent({
      pubkey: "zapper",
      tags: [
        ["amount", "21000"],
        ["bolt11", "lnbc500u1ptest"],
      ],
    });
    assert.equal(extractZapSats(zap), 21); // amount tag wins
  });

  it("returns 0 when no amount or bolt11 tag", () => {
    const zap = makeEvent({ pubkey: "zapper", tags: [] });
    assert.equal(extractZapSats(zap), 0);
  });

  it("returns 0 for zero amount", () => {
    const zap = makeEvent({
      pubkey: "zapper",
      tags: [["amount", "0"]],
    });
    assert.equal(extractZapSats(zap), 0);
  });
});

// ---------------------------------------------------------------------------
// countByAuthor
// ---------------------------------------------------------------------------

describe("countByAuthor", () => {
  it("counts posts per author", () => {
    const posts = [
      makeEvent({ pubkey: "alice", tags: [] }),
      makeEvent({ pubkey: "alice", tags: [] }),
      makeEvent({ pubkey: "bob", tags: [] }),
    ];
    const counts = countByAuthor(posts);
    assert.equal(counts.get("alice"), 2);
    assert.equal(counts.get("bob"), 1);
  });

  it("returns empty map for empty input", () => {
    assert.equal(countByAuthor([]).size, 0);
  });
});

// ---------------------------------------------------------------------------
// countHashtags
// ---------------------------------------------------------------------------

describe("countHashtags", () => {
  it("counts hashtag occurrences across posts", () => {
    const posts = [
      makeEvent({ pubkey: "alice", tags: [["t", "nostr"]] }),
      makeEvent({
        pubkey: "bob",
        tags: [
          ["t", "nostr"],
          ["t", "bitcoin"],
        ],
      }),
      makeEvent({ pubkey: "carol", tags: [["t", "bitcoin"]] }),
    ];
    const counts = countHashtags(posts);
    assert.equal(counts.get("nostr"), 2);
    assert.equal(counts.get("bitcoin"), 2);
  });

  it("excludes app-specific hashtags", () => {
    const posts = [
      makeEvent({
        pubkey: "alice",
        tags: [
          ["t", "pathos-challenge"],
          ["t", "activism"],
          ["t", "nostr"],
        ],
      }),
    ];
    const counts = countHashtags(posts);
    assert.equal(counts.has("pathos-challenge"), false);
    assert.equal(counts.has("activism"), false);
    assert.equal(counts.get("nostr"), 1);
  });

  it("returns empty map for empty input", () => {
    assert.equal(countHashtags([]).size, 0);
  });

  it("ignores tags without values", () => {
    const posts = [makeEvent({ pubkey: "alice", tags: [["t"]] })];
    assert.equal(countHashtags(posts).size, 0);
  });
});

// ---------------------------------------------------------------------------
// aggregateZaps
// ---------------------------------------------------------------------------

describe("aggregateZaps", () => {
  it("aggregates total amount, count, donors and contributors", () => {
    const zaps = [
      makeEvent({
        pubkey: "relay",
        tags: [
          ["amount", "10000"], // 10 sats
          ["P", "donor1"],
          ["p", "recipient1"],
        ],
      }),
      makeEvent({
        pubkey: "relay",
        tags: [
          ["amount", "20000"], // 20 sats
          ["P", "donor1"],
          ["p", "recipient2"],
        ],
      }),
      makeEvent({
        pubkey: "relay",
        tags: [
          ["amount", "5000"], // 5 sats
          ["P", "donor2"],
          ["p", "recipient1"],
        ],
      }),
    ];

    const result = aggregateZaps(zaps);

    assert.equal(result.zapAmount, 35);
    assert.equal(result.zapCnt, 3);

    // Donors
    assert.equal(result.donors.size, 2);
    assert.equal(result.donors.get("donor1")?.totalSats, 30);
    assert.equal(result.donors.get("donor1")?.zapCount, 2);
    assert.equal(result.donors.get("donor2")?.totalSats, 5);

    // Contributors
    assert.equal(result.contributors.size, 2);
    assert.equal(result.contributors.get("recipient1")?.totalSats, 15);
    assert.equal(result.contributors.get("recipient1")?.zapCount, 2);
    assert.equal(result.contributors.get("recipient2")?.totalSats, 20);
  });

  it("skips zaps with zero amount", () => {
    const zaps = [
      makeEvent({
        pubkey: "relay",
        tags: [
          ["amount", "0"],
          ["P", "donor"],
          ["p", "recipient"],
        ],
      }),
    ];
    const result = aggregateZaps(zaps);
    assert.equal(result.zapAmount, 0);
    assert.equal(result.zapCnt, 0);
    assert.equal(result.donors.size, 0);
  });

  it("returns zeros for empty input", () => {
    const result = aggregateZaps([]);
    assert.equal(result.zapAmount, 0);
    assert.equal(result.zapCnt, 0);
  });
});

// ---------------------------------------------------------------------------
// aggregateActionZaps
// ---------------------------------------------------------------------------

describe("aggregateActionZaps", () => {
  it("attributes zaps to actions via submission event IDs", () => {
    const now = 1_000_000;
    const actionTag = "36639:pub:action1";

    const submission = makeEvent({
      id: "sub1",
      pubkey: "author",
      created_at: now - 100, // recent: within 7d
      tags: [],
    });

    const zap = makeEvent({
      pubkey: "relay",
      tags: [
        ["e", "sub1"],
        ["amount", "50000"], // 50 sats
      ],
    });

    const submissions = new Map([[actionTag, [submission]]]);
    const result = aggregateActionZaps([zap], submissions, now);

    assert.ok(result.has(actionTag));
    const record = result.get(actionTag)!;
    assert.equal(record.all.zapAmount, 50);
    assert.equal(record.all.zapCnt, 1);
    assert.equal(record["7d"].zapAmount, 50);
    assert.equal(record["30d"].zapAmount, 50);
    assert.equal(record["90d"].zapAmount, 50);
  });

  it("windows zaps by submission timestamp", () => {
    const now = 1_000_000;
    const day = 24 * 60 * 60;
    const actionTag = "36639:pub:action1";

    // Submission older than 7 days but within 30 days
    const oldSubmission = makeEvent({
      id: "old_sub",
      pubkey: "author",
      created_at: now - 10 * day,
      tags: [],
    });

    const zap = makeEvent({
      pubkey: "relay",
      tags: [
        ["e", "old_sub"],
        ["amount", "100000"],
      ],
    });

    const submissions = new Map([[actionTag, [oldSubmission]]]);
    const result = aggregateActionZaps([zap], submissions, now);

    const record = result.get(actionTag)!;
    assert.equal(record.all.zapAmount, 100);
    assert.equal(record["7d"].zapAmount, 0); // outside 7d window
    assert.equal(record["30d"].zapAmount, 100); // within 30d
  });

  it("returns empty map when no submissions", () => {
    const result = aggregateActionZaps([], new Map(), 1_000_000);
    assert.equal(result.size, 0);
  });
});

// ---------------------------------------------------------------------------
// windowedTags
// ---------------------------------------------------------------------------

describe("windowedTags", () => {
  it("generates windowed tag arrays", () => {
    const values = { all: 100, "7d": 50, "30d": 75, "90d": 90 } as Record<
      "7d" | "30d" | "90d" | "all",
      number
    >;
    const tags = windowedTags("comment_cnt", values);

    assert.deepEqual(tags, [
      ["comment_cnt", "100"],
      ["comment_cnt_7d", "50"],
      ["comment_cnt_30d", "75"],
      ["comment_cnt_90d", "90"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergeLeaderboard
// ---------------------------------------------------------------------------

describe("mergeLeaderboard", () => {
  it("merges and sums entries across tag sets", () => {
    const tagSets: string[][][] = [
      [
        ["top_poster", "alice", "10"],
        ["top_poster", "bob", "5"],
      ],
      [
        ["top_poster", "alice", "8"],
        ["top_poster", "carol", "12"],
      ],
    ];

    const merged = mergeLeaderboard(tagSets, "top_poster", 2);

    // alice: 10 + 8 = 18, carol: 12, bob: 5
    assert.equal(merged.length, 3);
    assert.equal(merged[0][1], "alice");
    assert.equal(merged[0][2], "18");
    assert.equal(merged[1][1], "carol");
    assert.equal(merged[1][2], "12");
    assert.equal(merged[2][1], "bob");
    assert.equal(merged[2][2], "5");
  });

  it("limits to 10 entries", () => {
    const tagSets: string[][][] = [
      Array.from({ length: 15 }, (_, i) => [
        "top_poster",
        `user_${i}`,
        String(15 - i),
      ]),
    ];

    const merged = mergeLeaderboard(tagSets, "top_poster", 2);
    assert.equal(merged.length, 10);
  });

  it("ignores tags with different names", () => {
    const tagSets: string[][][] = [
      [
        ["top_poster", "alice", "10"],
        ["top_donor", "bob", "100"],
      ],
    ];

    const merged = mergeLeaderboard(tagSets, "top_poster", 2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0][1], "alice");
  });

  it("returns empty array for no matching tags", () => {
    const merged = mergeLeaderboard([[["other", "val"]]], "top_poster", 2);
    assert.equal(merged.length, 0);
  });
});
