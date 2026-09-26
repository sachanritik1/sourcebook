import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUE_NAME } from "./types";

export function createQueue(redisUrl: string): {
  queue: Queue;
  connection: IORedis;
} {
  // Publisher retries in its polling loop, rather than waiting indefinitely in an offline Redis client.
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  const queue = new Queue(QUEUE_NAME, { connection });
  return { queue, connection };
}
