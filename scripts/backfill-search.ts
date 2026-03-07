/**
 * Backfill script to populate the `search_text` field for existing documents.
 *
 * The `search_text` field contains the indexed full-text content, built per-kind:
 * - JSON kinds (0, 40, 41, 30017-30020): extract `name`, `about`, `description`,
 *   `display_name` from JSON content.
 * - All other kinds: use `content` as plaintext.
 * - All kinds: append values from searchable tags (`title`, `name`, `description`,
 *   `summary`, `location`, `subject`, `about`).
 * - Truncate to 8000 characters.
 *
 * This runs entirely server-side using a Painless script, so it is very
 * fast and does not require scrolling or client-side processing.
 *
 * Usage:
 *   bun run scripts/backfill-search.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("Starting search_text field backfill\n");

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
    // Add the search_text field mapping if it doesn't already exist.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            search_text: {
              type: "text",
              analyzer: "standard",
              fields: {
                url: {
                  type: "text",
                  analyzer: "url_analyzer",
                },
              },
            },
          },
        },
      });
      console.log("Ensured `search_text` mapping exists on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Count documents missing the search_text field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "search_text" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents without a search_text field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Use update_by_query with a Painless script to populate the field
    // server-side.
    console.log("Running update_by_query with Painless script...\n");

    const response = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "search_text" } }],
          },
        },
        script: {
          source: `
            int MAX_LEN = 8000;

            // JSON kinds: extract searchable fields from JSON content
            Set jsonKinds = new HashSet();
            jsonKinds.add(0);
            jsonKinds.add(40);
            jsonKinds.add(41);
            jsonKinds.add(30017);
            jsonKinds.add(30018);
            jsonKinds.add(30019);
            jsonKinds.add(30020);

            // Searchable tag names
            Set searchTags = new HashSet();
            searchTags.add('title');
            searchTags.add('name');
            searchTags.add('description');
            searchTags.add('summary');
            searchTags.add('location');
            searchTags.add('subject');
            searchTags.add('about');

            // JSON field names to extract
            String[] jsonFields = new String[] {'name', 'about', 'description', 'display_name'};

            StringBuilder sb = new StringBuilder();

            // 1. Extract from content
            if (jsonKinds.contains(ctx._source.kind)) {
              // Try to parse JSON content — Painless doesn't have JSON.parse,
              // so we do simple string extraction for known fields.
              String c = ctx._source.content;
              if (c != null && c.startsWith('{')) {
                for (String field : jsonFields) {
                  // Search for "field":"value" or "field": "value"
                  String key = '"' + field + '"';
                  int keyIdx = c.indexOf(key);
                  if (keyIdx >= 0) {
                    // Find the colon after the key
                    int colonIdx = c.indexOf(':', keyIdx + key.length());
                    if (colonIdx >= 0) {
                      // Find the opening quote of the value
                      int startQuote = c.indexOf('"', colonIdx + 1);
                      if (startQuote >= 0) {
                        // Find the closing quote (handle escaped quotes)
                        int endQuote = startQuote + 1;
                        while (endQuote < c.length()) {
                          if (c.charAt(endQuote) == (char)'"' && c.charAt(endQuote - 1) != (char)'\\\\') {
                            break;
                          }
                          endQuote++;
                        }
                        if (endQuote < c.length()) {
                          String val = c.substring(startQuote + 1, endQuote);
                          if (val.length() > 0) {
                            if (sb.length() > 0) sb.append('\\n');
                            sb.append(val);
                          }
                        }
                      }
                    }
                  }
                }
              }
            } else {
              // Plaintext content
              if (ctx._source.content != null && ctx._source.content.length() > 0) {
                sb.append(ctx._source.content);
              }
            }

            // 2. Extract searchable tags
            if (ctx._source.tags != null) {
              for (def tag : ctx._source.tags) {
                if (tag.length >= 2 && searchTags.contains(tag[0]) && tag[1].length() > 0) {
                  if (sb.length() > 0) sb.append('\\n');
                  sb.append(tag[1]);
                }
              }
            }

            // 3. Truncate
            String result = sb.toString();
            if (result.length() > MAX_LEN) {
              result = result.substring(0, MAX_LEN);
            }

            ctx._source.search_text = result;
          `,
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
