import readerWasm from "zxing-wasm/reader/zxing_reader.wasm";
import { handleRequest } from "./app.js";
import { usePrecompiledQrModule } from "./loungekey.js";
import {
  type AssetProvider,
  defaultMetadata,
  resolveAppearance,
} from "./model.js";

usePrecompiledQrModule(readerWasm as unknown as WebAssembly.Module);

interface Env {
  PASS_ASSETS: Fetcher;
  LOGIN_RATE_LIMITER: RateLimit;
  PASS_TYPE_IDENTIFIER?: string;
  PASS_TEAM_IDENTIFIER?: string;
  PASS_ORGANIZATION_NAME?: string;
  PASS_DESCRIPTION?: string;
  PASS_FOREGROUND_COLOR?: string;
  PASS_BACKGROUND_COLOR?: string;
  PASS_LABEL_COLOR?: string;
}

class WorkerAssets implements AssetProvider {
  constructor(private readonly binding: Fetcher) {}

  async get(name: string): Promise<Uint8Array | undefined> {
    // Static asset bindings match only the URL pathname; no DNS request occurs.
    const url = new URL(encodeURIComponent(name), "https://assets.local/");
    const response = await this.binding.fetch(url);
    return response.ok
      ? new Uint8Array(await response.arrayBuffer())
      : undefined;
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      metadata: {
        passTypeIdentifier:
          env.PASS_TYPE_IDENTIFIER || defaultMetadata.passTypeIdentifier,
        teamIdentifier:
          env.PASS_TEAM_IDENTIFIER || defaultMetadata.teamIdentifier,
        organizationName:
          env.PASS_ORGANIZATION_NAME || defaultMetadata.organizationName,
        description: env.PASS_DESCRIPTION || defaultMetadata.description,
      },
      appearance: resolveAppearance({
        foregroundColor: env.PASS_FOREGROUND_COLOR,
        backgroundColor: env.PASS_BACKGROUND_COLOR,
        labelColor: env.PASS_LABEL_COLOR,
      }),
      assets: new WorkerAssets(env.PASS_ASSETS),
      fetch,
      clientIp: (incoming: Request) =>
        incoming.headers.get("cf-connecting-ip") || undefined,
      consumeLoginLimit: (incoming: Request, username: string) =>
        consumeLoginLimit(env.LOGIN_RATE_LIMITER, incoming, username),
      runtime: "worker",
      trustProxy: false,
    });
  },
} satisfies ExportedHandler<Env>;

async function consumeLoginLimit(
  limiter: RateLimit,
  request: Request,
  username: string,
): Promise<boolean> {
  const usernameHash = await sha256(username);
  const keys = [`username:${usernameHash}`];
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) keys.push(`ip:${clientIp}`);
  const outcomes = await Promise.all(keys.map((key) => limiter.limit({ key })));
  return outcomes.every(({ success }) => success);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
