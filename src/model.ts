export interface Account {
  name: string;
  loungeNumber: string;
  cardLast4: string;
  expiration: string;
  dateAdded: string;
  qrMessage: string;
}

export interface PassMetadata {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
}

export interface PassAppearance {
  foregroundColor: string;
  backgroundColor: string;
  labelColor: string;
}

export interface AssetProvider {
  get(name: string): Promise<Uint8Array | undefined>;
}

export interface RuntimeConfig {
  metadata: PassMetadata;
  appearance: PassAppearance;
  assets: AssetProvider;
  fetch: typeof globalThis.fetch;
  runtime: "worker" | "node";
  trustProxy: boolean;
}

export const defaultMetadata: PassMetadata = {
  passTypeIdentifier: "pass.rocks.stek29.lounge-access",
  teamIdentifier: "XXXXXXXXXX",
  organizationName: "stek29",
  description: "Lounge Access Pass",
};

export const defaultAppearance: PassAppearance = {
  foregroundColor: "rgb(52, 73, 94)",
  backgroundColor: "rgb(255, 255, 255)",
  labelColor: "rgb(52, 73, 94)",
};

export function resolveAppearance(
  values: { [Key in keyof PassAppearance]?: string | undefined },
): PassAppearance {
  return {
    foregroundColor: normalizeColor(
      values.foregroundColor || defaultAppearance.foregroundColor,
    ),
    backgroundColor: normalizeColor(
      values.backgroundColor || defaultAppearance.backgroundColor,
    ),
    labelColor: normalizeColor(
      values.labelColor || defaultAppearance.labelColor,
    ),
  };
}

function normalizeColor(value: string): string {
  const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(
    value,
  );
  const channels = match?.slice(1).map(Number);
  if (!channels || channels.some((channel) => channel > 255))
    throw new Error(`invalid pass color: ${value}`);
  return `rgb(${channels.join(", ")})`;
}
