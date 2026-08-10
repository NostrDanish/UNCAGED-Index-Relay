# SIP-01 Relay Profile — UNCAGED Index Relay

This document defines how UNCAGED Index Relay stores, validates, indexes, and
serves [SIP-01](https://github.com/NostrDanish/0xSearchstr/blob/main/docs/SEARCH_INDEX_PROTOCOL.md)
web index observations (kind 39697). It is the contract between the relay and
the ecosystem: **Crawlstr and other crawlers publish, the relay validates and
indexes, search engines query and rank.**

> One shared decentralized index. Many independent indexers. Many independent
> search engines. No single owner. The relay never decides what the "best"
> result is — it provides signals; ranking and filtering belong to the
> engines.

## 1. Ingestion validation

Kind 39697 events are strictly validated at ingestion. Invalid observations
are rejected with an `OK false` `invalid:` message and never reach the index
(SIP-01 §16 reader guidance, applied at the door).

| Rule | Failure message prefix |
|---|---|
| Exactly one `d`, `u`, `v`, `alt` tag each | `missing … tag` / `multiple … tags` |
| `v` must be `"1"` | `unsupported web document schema version` |
| `alt` non-empty, ≤ 1000 chars | `missing alt tag` / `alt tag exceeds …` |
| `u` ≤ 2048 chars, valid `http(s)` URL | `u tag is not a valid http(s) URL` |
| `d` == `widx:` + `sha256(normalize(u))[0:32]` | `d tag does not match the normalized u tag` |
| Content is JSON with a `title` string | `content is not valid JSON with a title` |
| `title` 1–300 chars after trim | `title must be 1-300 characters` |
| `description` ≤ 1000 chars | `description exceeds 1000 characters` |
| `image` must be an `https:` URL | `image must be an https URL` |
| ≤ 8 `t` topic tags, lowercase | `more than 8 topic tags` / `topic (t) tags must be lowercase` |
| `l` is ISO 639-1 | `l tag is not a valid ISO 639-1 language code` |
| `x` is 64 lowercase hex **and** matches `sha256(title + "\n" + description)` | `x tag must be …` / `x tag does not match …` |
| `published` is unix seconds | `published tag must be a unix timestamp` |
| `source` ≤ 100 chars | `source tag exceeds …` |
| Extension tags `type`/`platform`/`category`/`network` are keyword-shaped | `… tag is not a valid keyword` |
| `country` is ISO 3166-1 alpha-2 | `country tag must be …` |
| `mime` is a valid MIME type | `mime tag is not a valid MIME type` |

URL normalization is SIP-01 §8, byte-compatible with the reference
implementation (`normalizeIndexUrl()` in `src/web-document.ts`): strip
`www.`, drop default ports, remove the fragment, delete known tracking
parameters (`utm_*`, `fbclid`, `gclid`, …), sort remaining query parameters
by key, remove trailing slashes (except the root).

Events with an unknown `v` are rejected — a relay cannot index what it cannot
interpret. Unknown *tags* are ignored, so SIP-01 extensions stay forwards
compatible.

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
| `title` | text + `keyword` subfield | content JSON |
| `description` | text | content JSON |
| `image` | keyword | content JSON |
| `language` | keyword | `l` tag (precedence over detection) |
| `content_hash` | keyword | `x` tag |
| `published_at` | long | `published` tag |
| `observed_at` | long | event `created_at` (always set) |
| `source` | keyword | `source` tag |
| `doc_type` / `platform` / `category` / `network` | keyword | optional extension tags (lowercased) |
| `country` | keyword | `country` tag (uppercased) |
| `content_type` | keyword | `mime` tag (lowercased) |
| `crawl_score`, `authority_score`, `quality_score`, `spam_score` | float | relay-computed ranking signals, seeded 0 |

Topics (`t` tags) are indexed in `tags_map.t` and queryable via `#t` filters
and the `topic:` operator.

Derived fields are relay-internal — they are **not** published back to Nostr.
The Nostr event remains the source of truth; OpenSearch is the local
acceleration layer.

## 3. Deduplication and indexer agreement

- The `d` tag is deterministic across all indexers, so
  `{"kinds":[39697], "#d":["widx:…"]}` returns every independent observation
  of a URL, and COUNT with `distinct:author` approximates the
  independent-indexer count.
- Addressable slots are per `(pubkey, d)`: a recrawl replaces that indexer's
  previous observation. With history preservation enabled (default),
  superseded versions remain queryable — change tracking over time.
- Observations are never collapsed across indexers. Agreement (`same d`,
  same/different `x`) is exposed as data; interpreting it is the search
  engine's choice.

## 4. Querying

All standard NIP-01 filters work (`kinds`, `authors`, `#d`, `#t`, `#u`, `#x`,
`since`/`until` on observation time, `limit`). On top, NIP-50 `search`
understands free text (title + description + URL tokens) plus web-search
operators: `site:`, `domain:`, `url:`, `inurl:`, `title:`, `topic:`, `type:`,
`platform:`, `category:`, `network:`, `country:`, `mime:`, `filetype:`,
`source:`, `lang:`, `before:`, `after:`, `distinct:domain` — each with a
negated `-op:` form. See the README for the full reference.

```json
["REQ", "search", {
  "kinds": [39697],
  "search": "bitcoin privacy site:github.com lang:en after:2026-01-01",
  "limit": 50
}]
```

## 5. Capability advertisement (NIP-11)

The relay information document carries an `uncaged_index` block so search
engines can discover what this relay indexes and route queries accordingly:

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
keys can produce events, but it cannot fake independent observation *history*,
and engines are free to weight indexer age, diversity, and agreement.
