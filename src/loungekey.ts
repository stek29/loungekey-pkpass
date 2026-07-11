import type { Element } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { Account } from "./model.js";

const loginUrl = "https://www.loungekey.com/en/login";
const loginApiUrl =
  "https://www.loungekey.com/api/loungekey/lkaccount/login?sc_site=loungekey";
const userAgent = "loungekey-pkpass/3.0";
const monthNumbers = new Map(
  [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((month, index) => [month, index + 1]),
);

class CookieJar {
  readonly #cookies = new Map<string, string>();

  capture(headers: Headers): void {
    const rawValues =
      (
        headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
    const values = rawValues.flatMap((value) => splitSetCookie(value));
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0)
        this.#cookies.set(
          pair.slice(0, separator).trim(),
          pair.slice(separator + 1).trim(),
        );
    }
  }

  header(): string {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
}

async function loungeFetch(
  fetcher: typeof fetch,
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", userAgent);
  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetcher(url, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  jar.capture(response.headers);
  return response;
}

export async function fetchAccount(
  fetcher: typeof fetch,
  username: string,
  password: string,
): Promise<Account> {
  if (!username || !password)
    throw new Error("username and password are required");
  const jar = new CookieJar();
  const loginPage = await loungeFetch(fetcher, jar, loginUrl);
  if (!loginPage.ok)
    throw new Error(`LoungeKey login page returned ${loginPage.status}`);
  await loginPage.body?.cancel();

  const login = await loungeFetch(fetcher, jar, loginApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: loginUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      TimezoneOffset: String(new Date().getTimezoneOffset()),
      Username: username,
      Password: password,
    }),
  });
  if (!login.ok) throw new Error(`LoungeKey login returned ${login.status}`);
  const result = (await login.json()) as {
    RedirectUrl?: unknown;
    Success?: unknown;
  };
  if (
    result.Success !== true ||
    typeof result.RedirectUrl !== "string" ||
    !result.RedirectUrl
  ) {
    throw new Error("LoungeKey login failed");
  }

  const dashboardUrl = new URL(result.RedirectUrl, loginUrl);
  if (dashboardUrl.origin !== new URL(loginUrl).origin)
    throw new Error("LoungeKey returned an invalid dashboard URL");
  const dashboard = await loungeFetch(fetcher, jar, dashboardUrl.href);
  if (!dashboard.ok)
    throw new Error(`LoungeKey dashboard returned ${dashboard.status}`);
  return parseDashboard(await dashboard.text());
}

export async function parseDashboard(html: string): Promise<Account> {
  const document = parseDocument(html);
  const elements = DomUtils.findAll(() => true, document.children).filter(
    (node): node is Element => node.type === "tag",
  );
  const field = (label: string): string => {
    for (const element of elements) {
      if (element.name !== "li") continue;
      const strong = DomUtils.findOne(
        (node) => node.type === "tag" && (node as Element).name === "strong",
        element.children,
      );
      if (
        strong &&
        normalize(DomUtils.textContent(strong)).toLowerCase() ===
          label.toLowerCase()
      ) {
        const full = normalize(DomUtils.textContent(element));
        const heading = normalize(DomUtils.textContent(strong));
        const value = full.slice(heading.length).trim();
        if (value) return value;
      }
    }
    throw new Error(`LoungeKey dashboard field not found: ${label}`);
  };

  const qr = elements.find(
    (element) =>
      element.name === "img" &&
      element.attribs.class?.split(/\s+/).includes("qr-code"),
  );
  const source = qr?.attribs.src;
  if (!source) throw new Error("LoungeKey QR image was not found");
  const card = field("Card Details");
  if (card.length < 4) throw new Error("invalid LoungeKey card details");
  return {
    name: field("Name on card"),
    loungeNumber: field("Lounge Access Number"),
    cardLast4: card.slice(-4),
    expiration: parseWebsiteDate(field("Card Expiration Date")),
    dateAdded: parseWebsiteDate(field("Date Card Added")),
    qrMessage: await decodeQrDataUrl(source),
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseWebsiteDate(value: string): string {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value);
  const month = match ? monthNumbers.get(match[2] ?? "") : undefined;
  if (!match || !month) throw new Error("invalid LoungeKey date");
  const day = Number(match[1]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    throw new Error("invalid LoungeKey date");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export async function decodeQrDataUrl(source: string): Promise<string> {
  const match = /^data:image(?:\/(?:jpeg|jpg))?;base64,([A-Za-z0-9+/=]+)$/.exec(
    source,
  );
  if (!match?.[1]) throw new Error("invalid LoungeKey QR image data URL");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[1]), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error("invalid LoungeKey QR image data URL");
  }
  const results = await readBarcodes(bytes, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryHarder: true,
  });
  if (results.length !== 1 || !results[0]?.text)
    throw new Error("could not decode LoungeKey QR image");
  return results[0].text;
}

export function usePrecompiledQrModule(module: WebAssembly.Module): void {
  prepareZXingModule({
    overrides: {
      instantiateWasm(imports, successCallback) {
        const wasm = (
          globalThis as unknown as {
            WebAssembly: {
              Instance: new (
                module: WebAssembly.Module,
                imports?: object,
              ) => { exports: Record<string, unknown> };
            };
          }
        ).WebAssembly;
        const instance = new wasm.Instance(module, imports);
        successCallback(instance as Parameters<typeof successCallback>[0]);
        return instance.exports as never;
      },
    },
  });
}

export { CookieJar };
