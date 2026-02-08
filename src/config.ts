export class Config {
  private env: { get(key: string): string | undefined };

  constructor(env: { get(key: string): string | undefined }) {
    this.env = env;
  }

  get port(): number {
    const value = this.env.get("PORT");
    if (!value) {
      return 13131; // Default port
    }
    const port = parseInt(value, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error("PORT must be a valid port number (1-65535).");
    }
    return port;
  }

  get publicUrl(): string | undefined {
    return this.env.get("PUBLIC_URL");
  }

  get opensearchNode(): string {
    return this.env.get("OPENSEARCH_NODE") || "http://localhost:9200";
  }

  get opensearchIndex(): string {
    return this.env.get("OPENSEARCH_INDEX") || "nostr-events";
  }

  get opensearchUsername(): string | undefined {
    return this.env.get("OPENSEARCH_USERNAME");
  }

  get opensearchPassword(): string | undefined {
    return this.env.get("OPENSEARCH_PASSWORD");
  }

  get clusterWorkers(): number {
    const value = this.env.get("CLUSTER_WORKERS");
    if (!value) {
      return navigator.hardwareConcurrency;
    }
    const workers = parseInt(value, 10);
    if (Number.isNaN(workers) || workers < 0) {
      throw new Error("CLUSTER_WORKERS must be a non-negative number.");
    }
    return workers;
  }
}
