import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handleRequest, requestOrigin } from "../src/app.js";
import {
  CookieJar,
  decodeQrDataUrl,
  detectAccountType,
  fetchAccount,
  parseBenefits,
  parseDashboard,
  parseVisitHistory,
} from "../src/loungekey.js";
import {
  type AssetProvider,
  defaultAppearance,
  defaultMetadata,
  type Entitlement,
  type RuntimeConfig,
  resolveAppearance,
} from "../src/model.js";
import { buildPass, makePassJson } from "../src/pass.js";
import { decodePasswordToken, passwordToken } from "../src/token.js";

const account = {
  name: "Example Member",
  loungeNumber: "123456789",
  cardLast4: "1234",
  expiration: "2030-01-01",
  dateAdded: "2025-01-02",
  qrMessage: "fixture-qr-payload",
  entitlement: { type: "unknown" } as const,
  lastUpdated: "2026-07-11T11:17:00.000Z",
};

class MemoryAssets implements AssetProvider {
  async get(name: string): Promise<Uint8Array | undefined> {
    return name.startsWith("strip")
      ? undefined
      : new TextEncoder().encode(name);
  }
}

function config(fetcher: typeof fetch = fetch): RuntimeConfig {
  return {
    metadata: defaultMetadata,
    appearance: defaultAppearance,
    assets: new MemoryAssets(),
    fetch: fetcher,
    clientIp: () => undefined,
    consumeLoginLimit: async () => true,
    runtime: "node",
    trustProxy: false,
  };
}

describe("password tokens", () => {
  it("round trips UTF-8 without padding", () => {
    const password = "p@ss:/+ слово";
    const token = passwordToken(password);
    expect(token).not.toMatch(/[+/=]/);
    expect(decodePasswordToken(token)).toBe(password);
  });

  it("rejects invalid input", () =>
    expect(() => decodePasswordToken("***")).toThrow("invalid password token"));
});

it("collects response cookies", () => {
  const jar = new CookieJar();
  jar.capture(
    new Headers({ "Set-Cookie": "first=one; Path=/, second=two; HttpOnly" }),
  );
  expect(jar.header()).toBe("first=one; second=two");
});

it("decodes the harmless JPEG QR fixture", async () => {
  const jpeg = await readFile(new URL("fixtures/qr.jpg", import.meta.url));
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  expect(await decodeQrDataUrl(dataUrl)).toBe("fixture-qr-payload");
});

async function dashboardFixture(): Promise<string> {
  const jpeg = await readFile(new URL("fixtures/qr.jpg", import.meta.url));
  return `<ul>
    <li><strong>Name on card</strong> Example Member</li>
    <li><strong>Lounge Access Number</strong> 123456789</li>
    <li><strong>Card Details</strong> Visa ending 1234</li>
    <li><strong>Card Expiration Date</strong> 01 Jan 2030</li>
    <li><strong>Date Card Added</strong> 02 Jan 2025</li>
  </ul><p>Extra visits or guests are charged at US$35 per visit.</p>
  <img class="qr-code" src="data:image/jpeg;base64,${jpeg.toString("base64")}">`;
}

it("parses a LoungeKey dashboard fixture", async () => {
  const html = await dashboardFixture();
  expect(
    await parseDashboard(html, { type: "unknown" }, account.lastUpdated),
  ).toEqual(account);
  await expect(
    parseDashboard(html.replace("01 Jan 2030", "31 Feb 2030")),
  ).rejects.toThrow("invalid LoungeKey date");
});

it("detects only explicitly supported account packages", () => {
  expect(
    detectAccountType(
      new URL("https://www.loungekey.com/unlimitedch-kaz/dashboard/my-account"),
    ),
  ).toBe("unlimited");
  expect(
    detectAccountType(
      new URL("https://www.loungekey.com/en/10ch-kaz/dashboard/my-account"),
    ),
  ).toBe("limited");
  expect(
    detectAccountType(
      new URL("https://www.loungekey.com/en/20ch-kaz/dashboard/my-account"),
    ),
  ).toBe("unknown");
  expect(
    detectAccountType(new URL("https://www.loungekey.com/en/account")),
  ).toBe("unknown");
});

it("parses explicit remaining benefits and visit history", () => {
  expect(
    parseBenefits(`
      <span>ENTITLEMENT</span><span>Ends: 31 Dec 2026</span>
      <article><h3>Member visits</h3>
        <div class="entitlement-graph" data-available="7"></div>
        <span><span class="counter">0</span><span>Remaining</span></span>
      </article>`),
  ).toEqual({ remainingVisits: 7, ends: "2026-12-31" });
  expect(
    parseVisitHistory(`<table>
      <tr><th>Visit date</th><th>Lounge Code</th><th>Total customer &amp; guest visits</th></tr>
      <tr><td>10 Jul 2026</td><td><span class="table-tooltip-text">ALA3</span><span>Extime Business Lounge - ALA3</span></td><td>2</td></tr>
      <tr><td>12 Jan 2026</td><td>LHR1</td><td>1</td></tr>
      <tr><td>11 Jul 2026</td><td>DXB2</td><td>3</td></tr>
    </table>`),
  ).toEqual({
    recordedVisits: 6,
    lastVisit: { date: "2026-07-11", loungeCode: "DXB2" },
  });
  expect(parseVisitHistory("<p>No visits found.</p>")).toEqual({
    recordedVisits: 0,
  });
});

it("enriches known packages and skips enrichment for unknown packages", async () => {
  const html = await dashboardFixture();
  const benefits = `<p>Ends: 31 Dec 2026</p><article>
    <h3>Member visits</h3>
    <div class="entitlement-graph" data-available="4"></div>
    <p>0 Remaining</p>
  </article>`;
  const history = `<table>
    <tr><th>Visit date</th><th>Lounge Code</th><th>Total customer &amp; guest visits</th></tr>
    <tr><td>10 Jul 2026</td><td>ALA3</td><td>6</td></tr>
  </table>`;
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://www.loungekey.com/en/login")
      return new Response("login");
    if (url.includes("/api/loungekey/"))
      return Response.json({
        Success: true,
        RedirectUrl: "/en/10ch-kaz/dashboard/my-account",
      });
    if (url.endsWith("/my-account")) return new Response(html);
    if (url.endsWith("/my-benefits")) return new Response(benefits);
    if (url.endsWith("/visit-history")) return new Response(history);
    return new Response("not found", { status: 404 });
  };
  const result = await fetchAccount(fetcher, "member", "secret");
  expect(result.entitlement).toEqual({
    type: "limited",
    remainingVisits: 4,
    ends: "2026-12-31",
    recordedVisits: 6,
    lastVisit: { date: "2026-07-10", loungeCode: "ALA3" },
    additionalVisitFee: "US$35 per visit",
  });
  expect(requested.some((url) => url.endsWith("/my-benefits"))).toBe(true);
  expect(requested.some((url) => url.endsWith("/visit-history"))).toBe(true);

  requested.length = 0;
  const unknownFetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://www.loungekey.com/en/login")
      return new Response("login");
    if (url.includes("/api/loungekey/"))
      return Response.json({
        Success: true,
        RedirectUrl: "/en/future-package/dashboard/my-account",
      });
    return new Response(html);
  };
  expect(
    (await fetchAccount(unknownFetcher, "member", "secret")).entitlement,
  ).toEqual({ type: "unknown" });
  expect(requested).toHaveLength(3);
});

it("attributes the login attempt to the observed client IP", async () => {
  let attributedIp: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://www.loungekey.com/en/login")
      return new Response("login");
    if (url.includes("/api/loungekey/")) {
      attributedIp = new Headers(init?.headers).get(
        "x-loungekey-pkpass-client-ip",
      );
      return Response.json({
        Success: true,
        RedirectUrl: "/en/future-package/dashboard/my-account",
      });
    }
    return new Response(await dashboardFixture());
  };

  await fetchAccount(fetcher, "member", "secret", "203.0.113.42");
  expect(attributedIp).toBe("203.0.113.42");
});

it("falls back when optional benefits are unavailable", async () => {
  const html = await dashboardFixture();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://www.loungekey.com/en/login")
      return new Response("login");
    if (url.includes("/api/loungekey/"))
      return Response.json({
        Success: true,
        RedirectUrl: "/10ch-kaz/dashboard/my-account",
      });
    if (url.endsWith("/my-account")) return new Response(html);
    return new Response("unavailable", { status: 503 });
  };
  expect((await fetchAccount(fetcher, "member", "secret")).entitlement).toEqual(
    { type: "unknown" },
  );
});

it("orders front and back fields for each entitlement type", () => {
  const pass = (entitlement: Entitlement) =>
    makePassJson(
      { ...account, entitlement },
      {
        serialNumber: "serial",
        webServiceUrl: "https://passes.example",
        authenticationToken: "token",
        metadata: defaultMetadata,
        appearance: defaultAppearance,
      },
    ).generic as {
      headerFields: Array<{ key: string }>;
      secondaryFields: Array<{ key: string }>;
      backFields: Array<{ key: string }>;
    };
  const unlimited = pass({
    type: "unlimited",
    recordedVisits: 1,
    lastVisit: { date: "2026-07-10", loungeCode: "ALA3" },
    guestFee: "US$35 per visit",
  });
  expect(unlimited.headerFields.map(({ key }) => key)).toEqual(["cardOnFile"]);
  expect(unlimited.secondaryFields.map(({ key }) => key)).toEqual([
    "loungeNumber",
    "expiration",
    "dateAdded",
  ]);
  expect(unlimited.backFields.map(({ key }) => key)).toEqual([
    "access",
    "recordedVisits",
    "lastVisit",
    "visitFee",
    "lastUpdated",
  ]);
  expect(
    pass({
      type: "limited",
      remainingVisits: 10,
      ends: "2026-12-31",
      recordedVisits: 0,
    }).backFields.map(({ key }) => key),
  ).toEqual(["access", "recordedVisits", "entitlementEnds", "lastUpdated"]);
  expect(pass({ type: "unknown" }).backFields.map(({ key }) => key)).toEqual([
    "lastUpdated",
  ]);
});

it("normalizes and validates configurable pass colors", () => {
  expect(resolveAppearance({ foregroundColor: "rgb(1,2, 3)" })).toEqual({
    ...defaultAppearance,
    foregroundColor: "rgb(1, 2, 3)",
  });
  expect(() =>
    resolveAppearance({ backgroundColor: "rgb(256, 0, 0)" }),
  ).toThrow("invalid pass color");
});

it("builds a standard SHA-1 manifest without strips", async () => {
  const bytes = await buildPass(
    account,
    {
      serialNumber: "member@example.com",
      webServiceUrl: "https://passes.example.com/",
      authenticationToken: "token",
      metadata: defaultMetadata,
      appearance: {
        foregroundColor: "rgb(1, 2, 3)",
        backgroundColor: "rgb(4, 5, 6)",
        labelColor: "rgb(7, 8, 9)",
      },
    },
    new MemoryAssets(),
  );
  const files = unzipSync(bytes);
  expect(Object.keys(files)).not.toContain("strip.png");
  expect(Object.keys(files)).not.toContain("strip@2x.png");
  const manifest = JSON.parse(
    new TextDecoder().decode(files["manifest.json"]),
  ) as Record<string, string>;
  for (const [name, digest] of Object.entries(manifest)) {
    expect(digest).toBe(
      createHash("sha1")
        .update(files[name] as Uint8Array)
        .digest("hex"),
    );
  }
  const pass = JSON.parse(
    new TextDecoder().decode(files["pass.json"]),
  ) as Record<string, unknown>;
  expect(pass.webServiceURL).toBe("https://passes.example.com");
  expect(pass.foregroundColor).toBe("rgb(1, 2, 3)");
});

it("trusts forwarded origin only when explicitly enabled for Node", () => {
  const request = new Request("http://internal:8080/", {
    headers: {
      "X-Forwarded-Host": "passes.example.com",
      "X-Forwarded-Proto": "https",
    },
  });
  expect(requestOrigin(request, { runtime: "node", trustProxy: false })).toBe(
    "http://internal:8080",
  );
  expect(requestOrigin(request, { runtime: "node", trustProxy: true })).toBe(
    "https://passes.example.com",
  );
  expect(requestOrigin(request, { runtime: "worker", trustProxy: true })).toBe(
    "http://internal:8080",
  );
});

it("returns health, form, errors, and no-store headers", async () => {
  for (const [path, expected] of [
    ["/healthz", 200],
    ["/", 200],
    ["/missing", 404],
  ] as const) {
    const response = await handleRequest(
      new Request(`https://passes.example${path}`),
      config(),
    );
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
  }
});

it("applies the shared login limiter to generation and refresh", async () => {
  const usernames: string[] = [];
  const runtime = config(async () => {
    throw new Error("LoungeKey must not be called");
  });
  runtime.consumeLoginLimit = async (_request, username) => {
    usernames.push(username);
    return false;
  };

  const generated = await handleRequest(
    new Request("https://passes.example/generate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=member&password=secret",
    }),
    runtime,
  );
  const refreshed = await handleRequest(
    new Request(
      `https://passes.example/v1/passes/${defaultMetadata.passTypeIdentifier}/member`,
      { headers: { Authorization: `ApplePass ${passwordToken("secret")}` } },
    ),
    runtime,
  );

  expect(generated.status).toBe(429);
  expect(refreshed.status).toBe(429);
  expect(usernames).toEqual(["member", "member"]);
});

it("serves the same logo asset referenced by the form", async () => {
  const form = await handleRequest(
    new Request("https://passes.example/"),
    config(),
  );
  expect(await form.text()).toContain('src="/pass-logo.png"');

  const logo = await handleRequest(
    new Request("https://passes.example/pass-logo.png"),
    config(),
  );
  expect(logo.status).toBe(200);
  expect(logo.headers.get("content-type")).toBe("image/png");
  expect(new TextDecoder().decode(await logo.arrayBuffer())).toBe("logo.png");
});

it("regenerates a pass through the refresh route", async () => {
  let call = 0;
  const jpeg = await readFile(new URL("fixtures/qr.jpg", import.meta.url));
  const fetcher: typeof fetch = async (_input, init) => {
    call++;
    if (call === 1)
      return new Response("login", {
        headers: { "Set-Cookie": "session=one; Path=/" },
      });
    if (call === 2) {
      expect(new Headers(init?.headers).get("cookie")).toBe("session=one");
      return Response.json(
        { Success: true, RedirectUrl: "/en/account" },
        { headers: { "Set-Cookie": "auth=two; Path=/" } },
      );
    }
    expect(new Headers(init?.headers).get("cookie")).toBe(
      "session=one; auth=two",
    );
    const html = `<li><strong>Name on card</strong>${account.name}</li>
      <li><strong>Lounge Access Number</strong>${account.loungeNumber}</li>
      <li><strong>Card Details</strong>xxxx${account.cardLast4}</li>
      <li><strong>Card Expiration Date</strong>01 Jan 2030</li>
      <li><strong>Date Card Added</strong>02 Jan 2025</li>
      <img class="qr-code" src="data:image/jpeg;base64,${jpeg.toString("base64")}">`;
    return new Response(html);
  };
  const username = "member@example.com";
  const response = await handleRequest(
    new Request(
      `https://passes.example/v1/passes/${defaultMetadata.passTypeIdentifier}/${encodeURIComponent(username)}`,
      {
        headers: { Authorization: `ApplePass ${passwordToken("secret")}` },
      },
    ),
    config(fetcher),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "application/vnd.apple.pkpass",
  );
  expect(call).toBe(3);
});
