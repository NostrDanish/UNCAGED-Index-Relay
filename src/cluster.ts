import process from "node:process";
import type { Subprocess } from "bun";
import { Config } from "./config.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

const numWorkers = config.clusterWorkers;

console.log(
  `Starting ${numWorkers} worker processes with SO_REUSEPORT on port ${config.port}`,
);

const workers: Subprocess[] = new Array(numWorkers);

for (let i = 0; i < numWorkers; i++) {
  workers[i] = Bun.spawn({
    cmd: ["bun", "src/server.ts"],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      WORKER_ID: `worker-${i + 1}`,
    },
  });
}

function kill() {
  for (const worker of workers) {
    worker.kill();
  }
}

process.on("SIGINT", kill);
process.on("exit", kill);
