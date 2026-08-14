import type { Account, Entitlement, VisitSummary } from "./model.js";

const tokenUrl = "https://lbapi.prod.cloud-te-collinson.com/api/v1/admin/token";
const consumerApiUrl = "https://api.te-collinson.com/prioritypass/v1/consumer/";
const userAgent = "loungekey-pkpass/4.0";

export interface MobileToken {
  accessToken: string;
  expiresAt: number;
}

export class MobileAuthenticationError extends Error {}

interface UserInfo {
  CardholderName?: unknown;
  CurrentDMCBarcode?: unknown;
  MembershipExpiry?: unknown;
  MembershipNumber?: unknown;
  MembershipStart?: unknown;
  ObfuscatedPan?: unknown;
}

interface ChargeData {
  MemberChargeVisitfee?: unknown;
  MemberChargeVisitFeeCurrency?: unknown;
}

interface AllocationParty {
  Entitlement?: unknown;
  Remaining?: unknown;
  MemberChargeData?: ChargeData;
}

interface Allocation {
  AllocationType?: unknown;
  Guest?: AllocationParty;
  Member?: AllocationParty;
  ValidTo?: unknown;
}

interface RealtimeAllocation {
  Balance?: { Allocations?: unknown };
}

interface Visit {
  LoungeCode?: unknown;
  TotalVisitors?: unknown;
  VisitDate?: unknown;
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("password is required");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export async function login(
  fetcher: typeof fetch,
  username: string,
  passwordHash: string,
  clientIp?: string,
): Promise<MobileToken> {
  if (!username || !/^[0-9A-F]{64}$/.test(passwordHash))
    throw new Error("username and password hash are required");
  const body = new URLSearchParams({
    clientId: "mobileApp",
    clientSecret: "clientSecret",
    grantType: "password",
    password: passwordHash,
    productCode: "LK",
    username,
  });
  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      ...(clientIp ? { "X-LoungeKey-Pkpass-Client-IP": clientIp } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new MobileAuthenticationError(
      `LoungeKey mobile login returned ${response.status}`,
    );
  const result = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  if (
    typeof result.access_token !== "string" ||
    !result.access_token ||
    result.token_type !== "bearer" ||
    typeof result.expires_in !== "number" ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  ) {
    throw new Error("invalid LoungeKey mobile login response");
  }
  return {
    accessToken: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1_000,
  };
}

export async function fetchAccount(
  fetcher: typeof fetch,
  accessToken: string,
): Promise<Account> {
  if (!accessToken) throw new MobileAuthenticationError("token is required");
  const user = await fetchRequired<UserInfo>(fetcher, accessToken, "userInfo");
  const [allocation, visits] = await Promise.all([
    fetchOptional<RealtimeAllocation>(
      fetcher,
      accessToken,
      "realtimeAllocation",
    ),
    fetchOptional<Visit[]>(fetcher, accessToken, "visits"),
  ]);
  return parseAccount(user, allocation, visits, new Date().toISOString());
}

export function parseAccount(
  user: UserInfo,
  allocation?: RealtimeAllocation,
  visits?: Visit[],
  lastUpdated = new Date().toISOString(),
): Account {
  const obfuscatedPan = requiredString(user.ObfuscatedPan, "ObfuscatedPan");
  const last4 = /(\d{4})$/.exec(obfuscatedPan)?.[1];
  if (!last4) throw new Error("invalid LoungeKey ObfuscatedPan");
  return {
    name: requiredString(user.CardholderName, "CardholderName"),
    loungeNumber: requiredString(user.MembershipNumber, "MembershipNumber"),
    cardLast4: last4,
    expiration: parseApiDate(user.MembershipExpiry, "MembershipExpiry"),
    dateAdded: parseApiDate(user.MembershipStart, "MembershipStart"),
    qrMessage: requiredString(user.CurrentDMCBarcode, "CurrentDMCBarcode"),
    entitlement: parseEntitlement(allocation, visits),
    lastUpdated,
  };
}

function parseEntitlement(
  response: RealtimeAllocation | undefined,
  visits: Visit[] | undefined,
): Entitlement {
  const allocations = response?.Balance?.Allocations;
  const visitAllocation = Array.isArray(allocations)
    ? (allocations as Allocation[]).find(
        ({ AllocationType }) => AllocationType === "VISIT",
      )
    : undefined;
  const member = visitAllocation?.Member;
  if (!visitAllocation || !member) return { type: "unknown" };
  const summary = parseVisits(visits);
  const guestFee = parseFee(visitAllocation.Guest?.MemberChargeData);
  if (member.Entitlement === "INFINITE") {
    return {
      type: "unlimited",
      ...summary,
      ...(guestFee ? { guestFee } : {}),
    };
  }
  const remaining = integerValue(member.Remaining);
  if (remaining === undefined) return { type: "unknown" };
  const additionalVisitFee = parseFee(member.MemberChargeData) ?? guestFee;
  return {
    type: "limited",
    remainingVisits: remaining,
    ends: parseApiDate(visitAllocation.ValidTo, "allocation ValidTo"),
    ...summary,
    ...(additionalVisitFee ? { additionalVisitFee } : {}),
  };
}

function parseVisits(visits: Visit[] | undefined): Partial<VisitSummary> {
  if (!Array.isArray(visits)) return {};
  const parsed = visits.map((visit) => ({
    date: parseApiDate(visit.VisitDate, "visit VisitDate"),
    loungeCode: requiredString(visit.LoungeCode, "visit LoungeCode"),
    total: integerValue(visit.TotalVisitors),
  }));
  if (parsed.some(({ total }) => total === undefined))
    throw new Error("invalid LoungeKey visit TotalVisitors");
  const latest = parsed.toSorted((left, right) =>
    right.date.localeCompare(left.date),
  )[0];
  return {
    recordedVisits: parsed.reduce((sum, { total }) => sum + (total ?? 0), 0),
    ...(latest
      ? { lastVisit: { date: latest.date, loungeCode: latest.loungeCode } }
      : {}),
  };
}

function parseFee(data: ChargeData | undefined): string | undefined {
  const amount =
    typeof data?.MemberChargeVisitfee === "string"
      ? data.MemberChargeVisitfee
      : undefined;
  const currency =
    typeof data?.MemberChargeVisitFeeCurrency === "string"
      ? data.MemberChargeVisitFeeCurrency
      : undefined;
  if (!amount || !currency || !/^\d+(?:\.\d{1,2})?$/.test(amount))
    return undefined;
  const prefix = currency === "USD" ? "US$" : `${currency} `;
  return `${prefix}${amount} per visit`;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`invalid LoungeKey ${field}`);
  return value;
}

function parseApiDate(value: unknown, field: string): string {
  const source = requiredString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(source);
  if (!match) throw new Error(`invalid LoungeKey ${field}`);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error(`invalid LoungeKey ${field}`);
  return date;
}

async function fetchRequired<Result>(
  fetcher: typeof fetch,
  accessToken: string,
  endpoint: string,
): Promise<Result> {
  const response = await fetcher(new URL(endpoint, consumerApiUrl), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403)
    throw new MobileAuthenticationError("LoungeKey mobile token is invalid");
  if (!response.ok)
    throw new Error(`LoungeKey mobile ${endpoint} returned ${response.status}`);
  return (await response.json()) as Result;
}

async function fetchOptional<Result>(
  fetcher: typeof fetch,
  accessToken: string,
  endpoint: string,
): Promise<Result | undefined> {
  try {
    return await fetchRequired<Result>(fetcher, accessToken, endpoint);
  } catch (error) {
    if (error instanceof MobileAuthenticationError) throw error;
    return undefined;
  }
}
