import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handleRequest, requestOrigin } from "../src/app.js";
import {
  fetchAccount,
  hashPassword,
  login,
  parseAccount,
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
import {
  decodePassCredentials,
  encodePassCredentials,
  passwordToken,
} from "../src/token.js";

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

const userInfo = {
  CardholderName: account.name,
  CurrentDMCBarcode: account.qrMessage,
  MembershipExpiry: "2030-01-01T00:00:00",
  MembershipNumber: account.loungeNumber,
  MembershipStart: "2025-01-02T00:00:00",
  ObfuscatedPan: `************${account.cardLast4}`,
};

const unlimitedAllocation = {
  Balance: {
    Allocations: [
      {
        AllocationType: "VISIT",
        ValidTo: "2026-12-31T23:59:59",
        Member: { Entitlement: "INFINITE", Remaining: "INFINITE" },
        Guest: {
          MemberChargeData: {
            MemberChargeVisitfee: "35",
            MemberChargeVisitFeeCurrency: "USD",
          },
        },
      },
    ],
  },
};

const visits = [
  {
    VisitDate: "2026-07-10T12:00:00",
    LoungeCode: "ALA3",
    TotalVisitors: 2,
  },
  {
    VisitDate: "2026-07-11T12:00:00",
    LoungeCode: "DXB2",
    TotalVisitors: 3,
  },
];

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

function accountApiResponse(url: string): Response {
  if (url.endsWith("/userInfo")) return Response.json(userInfo);
  if (url.endsWith("/realtimeAllocation"))
    return Response.json(unlimitedAllocation);
  if (url.endsWith("/visits")) return Response.json(visits);
  return new Response(null, { status: 404 });
}

function passJson(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes);
  return JSON.parse(new TextDecoder().decode(files["pass.json"])) as Record<
    string,
    unknown
  >;
}

describe("pass credentials", () => {
  it("uses an explicit version prefix and round trips current credentials", () => {
    const credentials = {
      accessToken: "mobile-token",
      expiresAt: 1_800_000_000_000,
      password: "secret",
    };
    const token = encodePassCredentials(credentials);
    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
    expect(decodePassCredentials(token)).toEqual({
      type: "current",
      credentials,
    });
  });

  it("recognizes unprefixed legacy password tokens", () => {
    const password = "p@ss:/+ слово";
    const token = passwordToken(password);
    expect(token).not.toMatch(/[+/=]/);
    expect(decodePassCredentials(token)).toEqual({ type: "legacy", password });
  });

  it("rejects malformed versioned credentials", () => {
    expect(() => decodePassCredentials("v2.invalid")).toThrow(
      "invalid pass credentials",
    );
    expect(() => decodePassCredentials("v3.future")).toThrow(
      "invalid pass credentials",
    );
  });
});

it("hashes mobile passwords as uppercase SHA-256", async () => {
  expect(await hashPassword("secret")).toBe(
    "2BB80D537B1DA3E38BD30361AA855686BDE0EACD7162FEF6A25FE97BF527A25B",
  );
});

it("logs in with required form fields and attributes the client IP", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(
      "https://lbapi.prod.cloud-te-collinson.com/api/v1/admin/token",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-loungekey-pkpass-client-ip")).toBe("203.0.113.42");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual(
      {
        clientId: "mobileApp",
        clientSecret: "clientSecret",
        grantType: "password",
        password: "A".repeat(64),
        productCode: "LK",
        username: "member",
      },
    );
    return Response.json({
      access_token: "mobile-token",
      token_type: "bearer",
      expires_in: 2_592_000,
    });
  };
  const before = Date.now();
  const token = await login(fetcher, "member", "A".repeat(64), "203.0.113.42");
  expect(token.accessToken).toBe("mobile-token");
  expect(token.expiresAt).toBeGreaterThanOrEqual(before + 2_592_000_000);
});

it("fetches account, allocation, and visits through the mobile API", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer mobile-token");
    expect(headers.has("x-session-id")).toBe(false);
    return accountApiResponse(url);
  };
  const result = await fetchAccount(fetcher, "mobile-token");
  expect({ ...result, lastUpdated: account.lastUpdated }).toEqual({
    ...account,
    entitlement: {
      type: "unlimited",
      recordedVisits: 5,
      lastVisit: { date: "2026-07-11", loungeCode: "DXB2" },
      guestFee: "US$35 per visit",
    },
  });
  expect(requested.map((url) => url.split("/").at(-1))).toEqual([
    "userInfo",
    "realtimeAllocation",
    "visits",
  ]);
});

it("parses finite mobile allocations", () => {
  const result = parseAccount(
    userInfo,
    {
      Balance: {
        Allocations: [
          {
            AllocationType: "VISIT",
            ValidTo: "2026-12-31T23:59:59",
            Member: {
              Entitlement: "10",
              Remaining: "4",
              MemberChargeData: {
                MemberChargeVisitfee: "35",
                MemberChargeVisitFeeCurrency: "USD",
              },
            },
          },
        ],
      },
    },
    [
      {
        VisitDate: "2026-07-10T12:00:00",
        LoungeCode: "ALA3",
        TotalVisitors: 6,
      },
    ],
    account.lastUpdated,
  );
  expect(result.entitlement).toEqual({
    type: "limited",
    remainingVisits: 4,
    ends: "2026-12-31",
    recordedVisits: 6,
    lastVisit: { date: "2026-07-10", loungeCode: "ALA3" },
    additionalVisitFee: "US$35 per visit",
  });
});

it("keeps optional mobile data failures from blocking the basic pass", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/userInfo")) return Response.json(userInfo);
    return new Response("unavailable", { status: 503 });
  };
  expect((await fetchAccount(fetcher, "mobile-token")).entitlement).toEqual({
    type: "unknown",
  });
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
  const pass = passJson(bytes);
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

it("applies the login limiter only when a mobile login is needed", async () => {
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

it("upgrades a legacy pass directly to versioned mobile credentials", async () => {
  let loginCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/admin/token")) {
      loginCalls++;
      return Response.json({
        access_token: "new-mobile-token",
        token_type: "bearer",
        expires_in: 2_592_000,
      });
    }
    return accountApiResponse(url);
  };
  const username = "member@example.com";
  const response = await handleRequest(
    new Request(
      `https://passes.example/v1/passes/${defaultMetadata.passTypeIdentifier}/${encodeURIComponent(username)}`,
      { headers: { Authorization: `ApplePass ${passwordToken("secret")}` } },
    ),
    config(fetcher),
  );
  expect(response.status).toBe(200);
  const updated = passJson(new Uint8Array(await response.arrayBuffer()));
  expect(updated.authenticationToken).toMatch(/^v2\./);
  const decoded = decodePassCredentials(String(updated.authenticationToken));
  expect(decoded.type).toBe("current");
  if (decoded.type === "current") {
    expect(decoded.credentials.accessToken).toBe("new-mobile-token");
    expect(decoded.credentials.password).toBe("secret");
  }
  expect(loginCalls).toBe(1);
});

it("reuses a valid mobile token without relogging", async () => {
  let limiterCalls = 0;
  const runtime = config(async (input) => {
    const url = String(input);
    expect(url).not.toContain("/admin/token");
    return accountApiResponse(url);
  });
  runtime.consumeLoginLimit = async () => {
    limiterCalls++;
    return true;
  };
  const credentials = encodePassCredentials({
    accessToken: "existing-mobile-token",
    expiresAt: Date.now() + 86_400_000,
    password: "secret",
  });
  const response = await handleRequest(
    new Request(
      `https://passes.example/v1/passes/${defaultMetadata.passTypeIdentifier}/member`,
      { headers: { Authorization: `ApplePass ${credentials}` } },
    ),
    runtime,
  );
  expect(response.status).toBe(200);
  expect(limiterCalls).toBe(0);
});

it("falls back to password login when a retained token is rejected", async () => {
  let loginCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/admin/token")) {
      loginCalls++;
      return Response.json({
        access_token: "replacement-token",
        token_type: "bearer",
        expires_in: 2_592_000,
      });
    }
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/userInfo") && authorization === "Bearer rejected-token")
      return new Response(null, { status: 401 });
    return accountApiResponse(url);
  };
  const credentials = encodePassCredentials({
    accessToken: "rejected-token",
    expiresAt: Date.now() + 86_400_000,
    password: "secret",
  });
  const response = await handleRequest(
    new Request(
      `https://passes.example/v1/passes/${defaultMetadata.passTypeIdentifier}/member`,
      { headers: { Authorization: `ApplePass ${credentials}` } },
    ),
    config(fetcher),
  );
  expect(response.status).toBe(200);
  expect(loginCalls).toBe(1);
});
