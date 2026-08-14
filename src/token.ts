export interface PassCredentials {
  accessToken: string;
  expiresAt: number;
  password: string;
}

export type DecodedPassCredentials =
  | { type: "current"; credentials: PassCredentials }
  | { type: "legacy"; password: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function encodePassCredentials(credentials: PassCredentials): string {
  validateCredentials(credentials);
  return `v2.${encodeBase64Url(
    JSON.stringify({
      v: 2,
      t: credentials.accessToken,
      e: credentials.expiresAt,
      p: credentials.password,
    }),
  )}`;
}

export function decodePassCredentials(token: string): DecodedPassCredentials {
  if (!token.startsWith("v2.")) return legacyPassword(decodeBase64Url(token));
  const decoded = decodeBase64Url(token.slice(3));
  try {
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object")
      throw new Error("invalid pass credentials");
    const envelope = value as {
      v?: unknown;
      t?: unknown;
      e?: unknown;
      p?: unknown;
    };
    if (envelope.v === 2) {
      const credentials = {
        accessToken: envelope.t,
        expiresAt: envelope.e,
        password: envelope.p,
      };
      validateCredentials(credentials);
      return { type: "current", credentials };
    }
  } catch {
    throw new Error("invalid pass credentials");
  }
  throw new Error("invalid pass credentials");
}

export function passwordToken(password: string): string {
  if (!password) throw new Error("password is required");
  return encodeBase64Url(password);
}

function legacyPassword(value: string): DecodedPassCredentials {
  if (!value) throw new Error("invalid pass credentials");
  return { type: "legacy", password: value };
}

function validateCredentials(value: {
  accessToken?: unknown;
  expiresAt?: unknown;
  password?: unknown;
}): asserts value is PassCredentials {
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0 ||
    typeof value.password !== "string" ||
    !value.password
  ) {
    throw new Error("invalid pass credentials");
  }
}

function encodeBase64Url(value: string): string {
  let binary = "";
  for (const byte of textEncoder.encode(value))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error("invalid pass credentials");
  const padded = token
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(token.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return textDecoder.decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new Error("invalid pass credentials");
  }
}
