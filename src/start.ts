import process from "node:process";
import { Config } from "./config.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// If CLUSTER_WORKERS is set and > 1, run in cluster mode
if (config.clusterWorkers > 1) {
  await import("./cluster.ts");
} else {
  await import("./server.ts");
}
