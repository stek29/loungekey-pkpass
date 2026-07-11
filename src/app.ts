import { generationForm } from "./form.js";
import { fetchAccount } from "./loungekey.js";
import type { RuntimeConfig } from "./model.js";
import { buildPass } from "./pass.js";
import { decodePasswordToken, passwordToken } from "./token.js";

const noStoreHeaders: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleRequest(
  request: Request,
  config: RuntimeConfig,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz")
      return textResponse("ok\n", 200);
    if (request.method === "GET" && url.pathname === "/")
      return htmlResponse(generationForm);
    if (request.method === "GET" && url.pathname === "/pass-logo.png")
      return await logoResponse(config);
    if (request.method === "POST" && url.pathname === "/generate")
      return await generate(request, config);
    if (request.method === "GET" && url.pathname.startsWith("/v1/passes/"))
      return await refresh(request, config);
    throw new HttpError(404, "not found");
  } catch (error) {
    if (error instanceof HttpError)
      return textResponse(`${error.message}\n`, error.status);
    console.error(
      "pass generation failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return textResponse("pass generation failed\n", 502);
  }
}

async function generate(
  request: Request,
  config: RuntimeConfig,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    throw new HttpError(415, "form content type is required");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 16_384) throw new HttpError(413, "form is too large");
  const body = await request.text();
  if (body.length > 16_384) throw new HttpError(413, "form is too large");
  const form = new URLSearchParams(body);
  const username = form.get("username")?.trim() ?? "";
  const password = form.get("password") ?? "";
  if (!username || !password)
    throw new HttpError(400, "username and password are required");
  await enforceLoginLimit(request, config, username);
  const account = await fetchAccount(
    config.fetch,
    username,
    password,
    config.clientIp(request),
  );
  const pass = await buildPass(
    account,
    {
      serialNumber: username,
      webServiceUrl: requestOrigin(request, config),
      authenticationToken: passwordToken(password),
      metadata: config.metadata,
      appearance: config.appearance,
    },
    config.assets,
  );
  return passResponse(pass, username);
}

async function refresh(
  request: Request,
  config: RuntimeConfig,
): Promise<Response> {
  const path = new URL(request.url).pathname.split("/");
  if (path.length !== 5 || !path[3] || !path[4])
    throw new HttpError(404, "not found");
  const passTypeIdentifier = decodePath(path[3]);
  const username = decodePath(path[4]);
  if (passTypeIdentifier !== config.metadata.passTypeIdentifier)
    throw new HttpError(404, "not found");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^ApplePass ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match?.[1]) throw new HttpError(401, "invalid authorization");
  let password: string;
  try {
    password = decodePasswordToken(match[1]);
  } catch {
    throw new HttpError(401, "invalid authorization");
  }
  await enforceLoginLimit(request, config, username);
  const account = await fetchAccount(
    config.fetch,
    username,
    password,
    config.clientIp(request),
  );
  const pass = await buildPass(
    account,
    {
      serialNumber: username,
      webServiceUrl: requestOrigin(request, config),
      authenticationToken: match[1],
      metadata: config.metadata,
      appearance: config.appearance,
    },
    config.assets,
  );
  return passResponse(pass, username);
}

async function enforceLoginLimit(
  request: Request,
  config: RuntimeConfig,
  username: string,
): Promise<void> {
  if (!(await config.consumeLoginLimit(request, username)))
    throw new HttpError(429, "too many login attempts");
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid URL path");
  }
}

export function requestOrigin(
  request: Request,
  config: Pick<RuntimeConfig, "runtime" | "trustProxy">,
): string {
  const direct = new URL(request.url).origin;
  if (config.runtime !== "node" || !config.trustProxy) return direct;
  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProto = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );
  if (
    !forwardedHost ||
    !/^https?$/.test(forwardedProto ?? "") ||
    !isValidHost(forwardedHost)
  )
    return direct;
  return `${forwardedProto}://${forwardedHost}`;
}

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function isValidHost(value: string): boolean {
  try {
    return (
      new URL(`https://${value}`).host === value && !/[\\/@\s]/.test(value)
    );
  } catch {
    return false;
  }
}

function passResponse(pass: Uint8Array, username: string): Response {
  const safeName =
    username.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "pass";
  return new Response(pass.buffer as ArrayBuffer, {
    headers: {
      ...noStoreHeaders,
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": `attachment; filename="${safeName}.pkpass"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...noStoreHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { ...noStoreHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

async function logoResponse(config: RuntimeConfig): Promise<Response> {
  const logo = await config.assets.get("logo.png");
  if (!logo) throw new HttpError(404, "pass logo not found");
  return new Response(logo.buffer as ArrayBuffer, {
    headers: {
      ...noStoreHeaders,
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export { noStoreHeaders };
