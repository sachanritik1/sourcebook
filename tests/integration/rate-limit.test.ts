import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import IORedis from "ioredis";
import request from "supertest";
import { createApp } from "../../src/app";
import { LocalLexicalEmbeddings } from "../../src/ai/embeddings";
import { LocalExtractiveAnswers } from "../../src/ai/answers";
import { limitEmbeddings } from "../../src/ai/provider-budget";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import {
  FixedWindowLimiter,
  type RateCounter,
} from "../../src/rate-limit/fixed-window";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!databaseUrl || !redisUrl)("API rate limits", () => {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const redis = redisUrl ? new IORedis(redisUrl) : null;
  const embeddings = new LocalLexicalEmbeddings();
  const searchLimiter = redis
    ? new FixedWindowLimiter(redis, 1000, `search-rate-test:${randomUUID()}`)
    : null;

  beforeAll(async () => {
    await migrate(databaseUrl!);
  });
  afterAll(async () => {
    await redis?.quit();
    await pool?.end();
  });

  it("limits general requests by socket IP while excluding health probes", async () => {
    const app = createApp(pool!, {
      embeddings,
      limiter: searchLimiter!,
      publicLimiter: new FixedWindowLimiter(
        redis!,
        2,
        `api-rate-test:${randomUUID()}`,
      ),
      authLimiter: new FixedWindowLimiter(
        redis!,
        100,
        `auth-rate-test:${randomUUID()}`,
      ),
    });
    await request(app).get("/health/live").expect(200);
    await request(app).get("/health/live").expect(200);
    await request(app).get("/health/ready").expect(200);
    await request(app)
      .get("/workspaces")
      .set("X-Forwarded-For", "1.1.1.1")
      .expect(401);
    await request(app)
      .get("/workspaces")
      .set("X-Forwarded-For", "2.2.2.2")
      .expect(401);
    const limited = await request(app)
      .get("/workspaces")
      .set("X-Forwarded-For", "3.3.3.3")
      .expect(429);
    expect(limited.body.error).toBe("api_rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("gives registration and login a stricter shared IP budget", async () => {
    const app = createApp(pool!, {
      embeddings,
      limiter: searchLimiter!,
      publicLimiter: new FixedWindowLimiter(
        redis!,
        100,
        `api-auth-test:${randomUUID()}`,
      ),
      authLimiter: new FixedWindowLimiter(
        redis!,
        1,
        `auth-tight-test:${randomUUID()}`,
      ),
    });
    const email = `limited-${randomUUID()}@example.com`;
    await request(app)
      .post("/auth/register")
      .send({ email, password: "a-long-test-password" })
      .expect(201);
    const limited = await request(app)
      .post("/auth/login")
      .send({ email, password: "a-long-test-password" })
      .expect(429);
    expect(limited.body.error).toBe("auth_rate_limited");
  });

  it("keeps ordinary API reads available when Redis fails but closes costly routes", async () => {
    const unavailable: RateCounter = {
      take: async () => {
        throw new Error("Redis unavailable");
      },
    };
    const app = createApp(pool!, {
      embeddings,
      limiter: unavailable,
      answers: new LocalExtractiveAnswers(),
      answerLimiter: unavailable,
      publicLimiter: unavailable,
      authLimiter: unavailable,
    });
    await request(app).get("/workspaces").expect(401);
    await request(app)
      .post("/auth/register")
      .send({
        email: `offline-${randomUUID()}@example.com`,
        password: "a-long-test-password",
      })
      .expect(503);

    const working = createApp(pool!, { embeddings, limiter: searchLimiter! });
    const owner = await request(working)
      .post("/auth/register")
      .send({
        email: `owner-${randomUUID()}@example.com`,
        password: "a-long-test-password",
      })
      .expect(201);
    const workspace = await request(working)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Rate limit outage" })
      .expect(201);
    const base = `/workspaces/${workspace.body.id}`;
    await request(app)
      .post(`${base}/documents`)
      .set("Idempotency-Key", randomUUID())
      .auth(owner.body.token, { type: "bearer" })
      .attach("file", Buffer.from("Upload survives Redis rate-limit outage"), {
        filename: "offline.txt",
        contentType: "text/plain",
      })
      .expect(202);
    const search = await request(app)
      .post(`${base}/search`)
      .auth(owner.body.token, { type: "bearer" })
      .send({ query: "evidence" })
      .expect(503);
    expect(search.body.error).toBe("rate_limit_unavailable");
    const question = await request(app)
      .post(`${base}/questions`)
      .auth(owner.body.token, { type: "bearer" })
      .send({ question: "What evidence?" })
      .expect(503);
    expect(question.body.error).toBe("rate_limit_unavailable");
  });

  it("returns Retry-After before calling a provider when shared capacity is full", async () => {
    let providerCalls = 0;
    const limited = limitEmbeddings(
      {
        model: embeddings.model,
        usdPerMillionTokens: 0,
        embed: async (inputs: string[]) => {
          providerCalls++;
          return embeddings.embed(inputs);
        },
      },
      { take: async () => false },
    );
    const app = createApp(pool!, {
      embeddings: limited,
      limiter: searchLimiter!,
    });
    const owner = await request(app)
      .post("/auth/register")
      .send({
        email: `capacity-${randomUUID()}@example.com`,
        password: "a-long-test-password",
      })
      .expect(201);
    const workspace = await request(app)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Provider capacity test" })
      .expect(201);
    const response = await request(app)
      .post(`/workspaces/${workspace.body.id}/search`)
      .auth(owner.body.token, { type: "bearer" })
      .send({ query: "capacity" })
      .expect(503);
    expect(response.body.error).toBe("provider_budget_exhausted");
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(providerCalls).toBe(0);
  });
});
