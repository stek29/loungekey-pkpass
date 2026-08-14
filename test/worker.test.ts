import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves routes inside workerd without exposing assets", async () => {
  const health = await SELF.fetch("https://worker.example/healthz");
  expect(health.status).toBe(200);
  expect(health.headers.get("cache-control")).toContain("no-store");

  const form = await SELF.fetch("https://worker.example/");
  expect(form.status).toBe(200);
  expect(await form.text()).toContain('<form method="post"');

  expect((await SELF.fetch("https://worker.example/icon.png")).status).toBe(
    404,
  );
});
