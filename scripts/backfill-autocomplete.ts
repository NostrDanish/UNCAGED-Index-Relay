/**
 * Backfill script to populate the `autocomplete_text` field for existing
 * documents.
 *
 * The `autocomplete_text` field is a short, name-shaped string indexed with
 * an edge-ngram analyzer, used by NIP-50 `autocomplete:true` queries. It is
 * built per-kind:
 * - JSON kinds (0): extract `name`, `display_name`, `nip05` from JSON content.
 * - JSON kinds (40, 41, 30017-30020): extract `name` from JSON content.
 * - All kinds: append values from autocomplete tags (`title`, `name`,
 *   `subject`, `d`).
 * - Truncate to 512 characters.
 *
 * Only documents that don't already have the field and that plausibly carry
 * autocomplete-shaped data are touched. This runs entirely server-side using
 * a Painless script, so it is very fast and does not require scrolling or
 * client-side processing.
 *
 * Usage:
 *   bun run scripts/backfill-autocomplete.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { buildAutocompleteTextPainlessScript } from "./painless.ts";

/** Kinds whose JSON content carries autocomplete-shaped fields. */
const JSON_KINDS = [0, 40, 41, 30017, 30018, 30019, 30020];

async function main() {
  console.log("Starting autocomplete_text field backfill\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${config.opensearchIndex}\n`);

  const clientOptions: ClientOptions = {
    node: config.opensearchNode,
  };

  if (config.opensearchUsername && config.opensearchPassword) {
    clientOptions.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }

  const client = new OpenSearchClient(clientOptions);

  try {
    // Add the autocomplete_text field mapping if it doesn't already exist.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            autocomplete_text: {
              type: "text",
              analyzer: "edge_ngram_analyzer",
              search_analyzer: "standard",
            },
          },
        },
      });
      console.log("Ensured `autocomplete_text` mapping exists on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Restrict the candidate set to documents that plausibly carry
    // autocomplete data:
    //   - kinds known to embed name fields in JSON content, OR
    //   - any document with a title/name/subject/d tag (via tags_map).
    // AND that don't already have the field populated.
    const candidateQuery = {
      bool: {
        must_not: [{ exists: { field: "autocomplete_text" } }],
        should: [
          { terms: { kind: JSON_KINDS } },
          { exists: { field: "tags_map.title" } },
          { exists: { field: "tags_map.name" } },
          { exists: { field: "tags_map.subject" } },
          { exists: { field: "tags_map.d" } },
        ],
        minimum_should_match: 1,
      },
    };

    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: { query: candidateQuery },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} candidate documents without an autocomplete_text field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    console.log("Running update_by_query with Painless script...\n");

    const response = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query: candidateQuery,
        script: {
          source: buildAutocompleteTextPainlessScript(),
          lang: "painless",
        },
      },
      refresh: true,
      conflicts: "proceed",
      wait_for_completion: true,
      // Allow the script to run for up to 2 hours
      timeout: "2h",
      scroll_size: 5000,
    });

    const result = response.body as {
      updated: number;
      version_conflicts?: number;
      failures?: unknown[];
      total?: number;
    };

    console.log(`Updated: ${(result.updated ?? 0).toLocaleString()}`);
    if (result.version_conflicts) {
      console.log(
        `Version conflicts (skipped): ${result.version_conflicts.toLocaleString()}`,
      );
    }
    if (result.failures && result.failures.length > 0) {
      console.warn(`Failures: ${result.failures.length}`);
      console.warn(JSON.stringify(result.failures.slice(0, 5), null, 2));
    }

    console.log("\nBackfill completed.");
  } catch (error) {
    console.error("\nBackfill failed:");
    if (error && typeof error === "object" && "meta" in error) {
      const meta = (error as { meta?: { body?: unknown } }).meta;
      console.error(JSON.stringify(meta?.body, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
