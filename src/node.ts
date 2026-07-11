import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { handleRequest, noStoreHeaders } from "./app.js";
import {
  type AssetProvider,
  defaultMetadata,
  resolveAppearance,
} from "./model.js";

class DirectoryAssets implements AssetProvider {
  constructor(private readonly directory: string) {}

  async get(name: string): Promise<Uint8Array | undefined> {
    if (!/^[A-Za-z0-9@._-]+$/.test(name)) return undefined;
    try {
      return new Uint8Array(await readFile(resolve(this.directory, name)));
    } catch {
      return undefined;
    }
  }
}

const host = process.env.HOST || "0.0.0.0";
const port = parsePort(process.env.PORT || "8080");
const assetsDirectory =
  process.env.PASS_ASSETS_DIR || resolve("assets/default");
const config = {
  metadata: {
    passTypeIdentifier:
      process.env.PASS_TYPE_IDENTIFIER || defaultMetadata.passTypeIdentifier,
    teamIdentifier:
      process.env.PASS_TEAM_IDENTIFIER || defaultMetadata.teamIdentifier,
    organizationName:
      process.env.PASS_ORGANIZATION_NAME || defaultMetadata.organizationName,
    description: process.env.PASS_DESCRIPTION || defaultMetadata.description,
  },
  appearance: resolveAppearance({
    foregroundColor: process.env.PASS_FOREGROUND_COLOR,
    backgroundColor: process.env.PASS_BACKGROUND_COLOR,
    labelColor: process.env.PASS_LABEL_COLOR,
  }),
  assets: new DirectoryAssets(assetsDirectory),
  fetch,
  clientIp: (request: Request) =>
    request.headers.get("x-loungekey-pkpass-observed-client-ip") || undefined,
  runtime: "node" as const,
  trustProxy: process.env.TRUST_PROXY === "true",
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await webRequest(incoming, config.trustProxy);
    const response = await handleRequest(request, config);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    console.error(
      "request failed",
      error instanceof Error ? error.message : "unknown error",
    );
    const tooLarge =
      error instanceof Error && error.message === "request body is too large";
    outgoing
      .writeHead(tooLarge ? 413 : 500, {
        ...noStoreHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end(
        tooLarge ? "request body is too large\n" : "internal server error\n",
      );
  }
});

server.listen(port, host, () =>
  console.log(`listening on http://${host}:${port}`),
);

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error("PORT must be between 1 and 65535");
  return parsed;
}

async function webRequest(
  incoming: IncomingMessage,
  trustProxy: boolean,
): Promise<Request> {
  const authority = incoming.headers.host || "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  headers.delete("x-loungekey-pkpass-observed-client-ip");
  const forwardedHeader = incoming.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedHeader)
    ? forwardedHeader[0]
    : forwardedHeader;
  const forwarded = trustProxy
    ? forwardedValue?.split(",", 1)[0]?.trim()
    : undefined;
  const observedIp = forwarded || incoming.socket.remoteAddress;
  if (observedIp && isIP(observedIp))
    headers.set("x-loungekey-pkpass-observed-client-ip", observedIp);
  const method = incoming.method || "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readBody(incoming);
  const init: RequestInit = { method, headers };
  if (body) init.body = body as Uint8Array<ArrayBuffer>;
  return new Request(`http://${authority}${incoming.url || "/"}`, init);
}

async function readBody(incoming: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of incoming) {
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk);
    length += bytes.length;
    if (length > 16_384) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
