import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { migratedDb } from "./d1-sqlite";

const empty = `Basic ${Buffer.from(":").toString("base64")}`;

describe("Worker auth with secrets unset (#32)", () => {
  const env = { DB: migratedDb().db } as unknown as Env;

  it("refuses the dashboard instead of admitting empty credentials", async () => {
    const res = await worker.fetch(new Request("https://x/api/state", { headers: { authorization: empty } }), env);
    expect(res.status).toBe(503);
  });

  it("refuses telemetry", async () => {
    const res = await worker.fetch(
      new Request("https://x/api/telemetry", { method: "POST", headers: { authorization: "Bearer " }, body: "{}" }),
      env,
    );
    expect(res.status).toBe(503);
  });

  it("still checks credentials when the secrets are set", async () => {
    const set = { ...env, DASHBOARD_USER: "u", DASHBOARD_PASSWORD: "p" } as Env;
    expect((await worker.fetch(new Request("https://x/", { headers: { authorization: empty } }), set)).status).toBe(401);
    const ok = `Basic ${Buffer.from("u:p").toString("base64")}`;
    expect((await worker.fetch(new Request("https://x/", { headers: { authorization: ok } }), set)).status).toBe(200);
  });
});
