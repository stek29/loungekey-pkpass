import { strToU8, zipSync } from "fflate";
import type {
  Account,
  AssetProvider,
  PassAppearance,
  PassMetadata,
} from "./model.js";

const assetNames = [
  "icon.png",
  "icon@2x.png",
  "logo.png",
  "logo@2x.png",
] as const;

export interface PassOptions {
  serialNumber: string;
  webServiceUrl: string;
  authenticationToken: string;
  metadata: PassMetadata;
  appearance: PassAppearance;
}

export async function buildPass(
  account: Account,
  options: PassOptions,
  assets: AssetProvider,
): Promise<Uint8Array> {
  validateAccount(account);
  if (!options.authenticationToken)
    throw new Error("authentication token is required");
  const files: Record<string, Uint8Array> = {};
  for (const name of assetNames) {
    const data = await assets.get(name);
    if (!data) throw new Error(`required pass asset is missing: ${name}`);
    files[name] = data;
  }
  files["pass.json"] = strToU8(
    JSON.stringify(makePassJson(account, options), null, 2),
  );

  const manifest: Record<string, string> = {};
  for (const [name, data] of Object.entries(files))
    manifest[name] = await sha1(data);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 9, mtime: new Date("1980-01-01T00:00:00Z") });
}

export function makePassJson(
  account: Account,
  options: PassOptions,
): Record<string, unknown> {
  const dateField = (
    key: string,
    label: string,
    value: string,
  ): Record<string, unknown> => ({
    key,
    label,
    value: `${value}T00:00:00Z`,
    dateStyle: "PKDateStyleMedium",
    timeStyle: "PKDateStyleNone",
    textAlignment: "PKTextAlignmentCenter",
    ignoresTimeZone: true,
  });
  return {
    description: options.metadata.description,
    formatVersion: 1,
    organizationName: options.metadata.organizationName,
    passTypeIdentifier: options.metadata.passTypeIdentifier,
    serialNumber: options.serialNumber,
    teamIdentifier: options.metadata.teamIdentifier,
    foregroundColor: options.appearance.foregroundColor,
    backgroundColor: options.appearance.backgroundColor,
    labelColor: options.appearance.labelColor,
    logoText: "",
    barcode: {
      message: account.qrMessage,
      format: "PKBarcodeFormatQR",
      messageEncoding: "iso-8859-1",
    },
    generic: {
      headerFields: [
        {
          key: "cardOnFile",
          label: "Card on File",
          value: `•${account.cardLast4}`,
        },
      ],
      primaryFields: [
        {
          key: "memberName",
          label: "Member",
          value: account.name,
          textAlignment: "PKTextAlignmentCenter",
        },
      ],
      secondaryFields: [
        {
          key: "loungeNumber",
          label: "Lounge Access Number",
          value: account.loungeNumber,
          textAlignment: "PKTextAlignmentCenter",
        },
        dateField("expiration", "Card Expiration Date", account.expiration),
        dateField("dateAdded", "Date Card Added", account.dateAdded),
      ],
    },
    webServiceURL: options.webServiceUrl.replace(/\/+$/, ""),
    authenticationToken: options.authenticationToken,
  };
}

function validateAccount(account: Account): void {
  if (!/^\d{4}$/.test(account.cardLast4))
    throw new Error("card-last4 must be exactly 4 digits");
  for (const [name, value] of [
    ["expiration", account.expiration],
    ["dateAdded", account.dateAdded],
  ] as const) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ) {
      throw new Error(`invalid ${name}`);
    }
  }
}

async function sha1(data: Uint8Array): Promise<string> {
  const source = new Uint8Array(data).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", source));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
