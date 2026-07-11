import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handleRequest, requestOrigin } from "../src/app.js";
import {
  CookieJar,
  decodeQrDataUrl,
  parseDashboard,
} from "../src/loungekey.js";
import {
  type AssetProvider,
  defaultAppearance,
  defaultMetadata,
  type RuntimeConfig,
  resolveAppearance,
} from "../src/model.js";
import { buildPass } from "../src/pass.js";
import { decodePasswordToken, passwordToken } from "../src/token.js";

const account = {
  name: "Example Member",
  loungeNumber: "123456789",
  cardLast4: "1234",
  expiration: "2030-01-01",
  dateAdded: "2025-01-02",
  qrMessage: "fixture-qr-payload",
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

it("parses a LoungeKey dashboard fixture", async () => {
  const jpeg = await readFile(new URL("fixtures/qr.jpg", import.meta.url));
  const html = `<ul>
    <li><strong>Name on card</strong> Example Member</li>
    <li><strong>Lounge Access Number</strong> 123456789</li>
    <li><strong>Card Details</strong> Visa ending 1234</li>
    <li><strong>Card Expiration Date</strong> 01 Jan 2030</li>
    <li><strong>Date Card Added</strong> 02 Jan 2025</li>
  </ul><img class="qr-code" src="data:image/jpeg;base64,${jpeg.toString("base64")}">`;
  expect(await parseDashboard(html)).toEqual(account);
  await expect(
    parseDashboard(html.replace("01 Jan 2030", "31 Feb 2030")),
  ).rejects.toThrow("invalid LoungeKey date");
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
