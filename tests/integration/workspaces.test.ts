import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { createApp } from "../../src/app";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("workspace isolation", () => {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const app = pool ? createApp(pool) : null;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    await pool!.query(
      "TRUNCATE sessions, workspace_memberships, workspaces, users CASCADE",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps workspace reads scoped to membership and revokes logout", async () => {
    const owner = await request(app!)
      .post("/auth/register")
      .send({ email: "owner@example.com", password: "a-long-test-password" })
      .expect(201);
    const other = await request(app!)
      .post("/auth/register")
      .send({ email: "other@example.com", password: "another-long-password" })
      .expect(201);
    const workspace = await request(app!)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Private research" })
      .expect(201);

    const ownerRead = await request(app!)
      .get(`/workspaces/${workspace.body.id}`)
      .auth(owner.body.token, { type: "bearer" })
      .expect(200);
    expect(ownerRead.body.role).toBe("owner");
    await request(app!)
      .get(`/workspaces/${workspace.body.id}`)
      .auth(other.body.token, { type: "bearer" })
      .expect(404);
    const otherList = await request(app!)
      .get("/workspaces")
      .auth(other.body.token, { type: "bearer" })
      .expect(200);
    expect(otherList.body.workspaces).toEqual([]);

    await request(app!)
      .post("/auth/logout")
      .auth(owner.body.token, { type: "bearer" })
      .expect(204);
    await request(app!)
      .get("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .expect(401);
  });

  it("does not leave a workspace without its owner", async () => {
    const owner = await request(app!)
      .post("/auth/login")
      .send({ email: "owner@example.com", password: "a-long-test-password" })
      .expect(200);
    const workspace = await request(app!)
      .post("/workspaces")
      .auth(owner.body.token, { type: "bearer" })
      .send({ name: "Another space" })
      .expect(201);
    const membership = await pool!.query(
      "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspace.body.id, owner.body.userId],
    );
    expect(membership.rows).toEqual([{ role: "owner" }]);
  });
});
