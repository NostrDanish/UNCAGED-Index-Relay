# SIP-01 Relay Profile — UNCAGED Index Relay

This document defines how UNCAGED Index Relay stores, validates, indexes, and
serves [SIP-01](https://github.com/NostrDanish/SIP-01) web index observations
(kind 39697). It is the relay-side profile referenced by the specification
(§20) — the contract between the relay and the ecosystem: **Crawlstr and
other crawlers publish, the relay validates and indexes, search engines query
and rank.**

> One shared decentralized index. Many independent indexers. Many independent
> search engines. No single owner. The relay never decides what the "best"
> result is — it provides signals; ranking and filtering belong to the
> engines.

Byte-compatibility is rule zero: this relay's URL normalization (§7) and
hashing (§3, §8) are covered by the spec's §13 test vectors in
`src/web-document.test.ts`. Keep them green — a single character of drift
breaks deduplication against every other implementation.

## 1. Ingestion validation

Kind 39697 events are strictly validated at ingestion. Invalid observations
are rejected with an `OK false` `invalid:` message and never reach the index
(spec §12.4 — reader guidance applied at the door; other relays remain free
to store kind 39697 without validation). Unknown **tags** are ignored (§9.1.3
forwards compatibility); unknown **versions** are rejected (§10).

| Rule | Failure message prefix |
|---|---|
| Exactly one `d`, `u`, `v`, `alt` tag each | `missing … tag` / `multiple … tags` |
| `v` must be `"1"` | `unsupported web document schema version` |
| `alt` non-empty, ≤ 1000 chars | `missing alt tag` / `alt tag exceeds …` |
| `u` ≤ 2048 chars, valid `http(s)` URL | `u tag is not a valid http(s) URL` |
| `d` == `widx:` + `sha256(normalize(u))[0:32]` (§3) | `d tag does not match the normalized u tag` |
| Content is JSON with a `title` string | `content is not valid JSON with a title` |
| `title` 1–300 chars after trim | `title must be 1-300 characters` |
| `description` ≤ 1000 chars | `description exceeds 1000 characters` |
| `image` is an `https:` URL | `image must be an https URL` |
| ≤ 8 `t` topic tags, `^[a-z0-9][a-z0-9-]{0,99}$` | `more than 8 topic tags` / `topic (t) tags must be lowercase` |
| `l` is ISO 639-1 | `l tag is not a valid ISO 639-1 language code` |
| `x` is 64 lowercase hex **and** matches `sha256(title + "\n" + description)` (§8) | `x tag must be …` / `x tag does not match …` |
| `published` is unix seconds | `published tag must be a unix timestamp` |
| `source` ≤ 100 chars | `source tag exceeds …` |
| Extension tags `type`/`platform`/`category`/`network` are keyword-shaped (§9.1.5) | `… tag is not a valid keyword` |
| `country` is ISO 3166-1 alpha-2 | `country tag must be …` |
| `mime` is a valid MIME type | `mime tag is not a valid MIME type` |

URL normalization implements spec §7 byte-compatibly with the reference
implementation (`normalizeIndexUrl()` in `src/web-document.ts`): strip
`www.`, drop default ports, remove the fragment, delete the 14 known tracking
parameters (`utm_*`, `fbclid`, `gclid`, …), sort remaining query parameters
by key (stable), remove trailing slashes (except the root), re-encode via
`URL.toString()`.

## 2. Indexed fields

Observations are indexed into dedicated fields (in addition to the generic
event fields, `tags_map`, and `search_text`, which contains
`title` + `description`):

| Field | Type | Source |
|---|---|---|
| `url` | keyword + `text` subfield | normalized `u` tag |
| `url_host` | keyword | host of `url` |
| `url_domain_hierarchy` | keyword[] | host + dotted parents (`docs.github.com` → both `docs.github.com` and `github.com`) |
| `file_ext` | keyword | extension of the URL path |
| `title` | text + `keyword` subfield | content JSON (also indexed for `autocomplete:`) |
| `description` | text | content JSON |
| `image` | keyword | content JSON |
| `language` | keyword | `l` tag (precedence over detection) |
| `content_hash` | keyword | `x` tag |
| `published_at` | long | `published` tag (§12.2 naming deviation, mapped here) |
| `observed_at` | long | event `created_at` (always set) |
| `source` | keyword | `source` tag |
| `doc_type` / `platform` / `category` / `network` | keyword | §9.2 extension tags (lowercased) |
| `country` | keyword | `country` tag (uppercased) |
| `content_type` | keyword | `mime` tag (lowercased) |
| `crawl_score`, `authority_score`, `quality_score`, `spam_score` | float | relay-computed ranking signals, seeded 0 — never published back into events (§1) |

Topics (`t` tags) are indexed in `tags_map.t` and queryable via `#t` filters
and the `topic:` operator. Baseline single-letter tags (`#d`, `#u`, `#x`,
`#v`, `#l`) are relay-filterable per NIP-01, exactly as the spec's query
model assumes.

Derived fields are relay-internal — they are **not** published back to Nostr.
The Nostr event remains the source of truth; OpenSearch is the local
acceleration layer.

## 3. Deduplication and indexer agreement

- The `d` tag is deterministic across all indexers, so
  `{"kinds":[39697], "#d":["widx:…"]}` returns every independent observation
  of a URL, and COUNT with `distinct:author` approximates the
  independent-indexer count.
- Addressable slots are per `(pubkey, d)`: a recrawl replaces that indexer's
  previous observation. With history preservation enabled (default), the
  relay MAY preserve superseded versions (§2) — it does, marked `replaced`
  and queryable via history filters, giving change tracking over time.
- Observations are never collapsed across indexers. Agreement (`same d`,
  same/different `x`) is exposed as data; interpreting it is the search
  engine's choice.

## 4. Querying

All standard NIP-01 filters work (`kinds`, `authors`, `#d`, `#t`, `#u`,
`#x`, `#v`, `#l`, `since`/`until` on observation time, `limit`). On top,
NIP-50 `search` understands free text (title + description + URL tokens)
plus web-search operators: `site:`, `domain:`, `url:`, `inurl:`, `title:`,
`topic:`, `type:`, `platform:`, `category:`, `network:`, `country:`,
`mime:`, `filetype:`, `source:`, `lang:`, `before:`, `after:`,
`distinct:domain` — each with a negated `-op:` form. NIP-50 sanctions
`key:value` extensions and requires relays to ignore unknown ones, so these
queries are safe to send anywhere.

```json
["REQ", "search", {
  "kinds": [39697],
  "search": "bitcoin privacy site:github.com lang:en after:2026-01-01",
  "limit": 50
}]
```

## 5. Capability advertisement (NIP-11)

The relay information document carries an `uncaged_index` block (spec §15) so
search engines can discover what this relay indexes and route queries
accordingly:

```json
{
  "uncaged_index": {
    "sip01": true,
    "nip50": true,
    "nip77": true,
    "document_kinds": [39697],
    "scope": "global",
    "domains": ["*"],
    "languages": ["en", "de"],
    "document_types": ["page", "repository"],
    "filters": ["site", "domain", "url", "inurl", "title", "topic", "type",
                "platform", "category", "network", "country", "mime",
                "filetype", "source", "lang", "before", "after",
                "distinct:domain"]
  }
}
```

`scope`, `domains`, `languages`, and `document_types` are operator-configured
(`UNCAGED_SCOPE`, `UNCAGED_DOMAINS`, `UNCAGED_LANGUAGES`,
`UNCAGED_DOC_TYPES`) — this is how specialized index relays
(EU/US/crypto/github/tor/…) declare themselves. `languages` and
`document_types` are omitted when unrestricted.

## 6. Federation

NIP-77 Negentropy sync works on any filter, so two relays can reconcile their
SIP-01 indexes efficiently:

```
["NEG-OPEN", "sync", {"kinds": [39697]}, <hex>]
```

No central master: any relay can ingest from crawlers, replicate from peers,
and serve search — the network survives any single relay disappearing.

## 7. Anti-spam stance

Valid signed observations are always stored. Abuse resistance comes from
scoring and filtering, not from a central approval list: invalid structure is
rejected at the door (§1), and relay-computed `spam_score` / agreement
signals let each search engine decide what to show. A flood of fake indexer
keys can produce events, but it cannot fake independent observation
*history*, and engines are free to weight indexer age, diversity, and
agreement.

## 8. Extending

Follow spec §9: experiment with `x-`-prefixed tags (ignored everywhere
safely), then register via a spec PR once one crawler publishes and one
engine consumes. This relay indexes the §9.2 registered set
(`type`/`platform`/`category`/`network`/`country`/`mime`); unknown tags pass
 through untouched and remain available in the raw event.
