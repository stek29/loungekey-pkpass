const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function passwordToken(password: string): string {
  let binary = "";
  for (const byte of textEncoder.encode(password))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodePasswordToken(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error("invalid password token");
  const padded = token
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(token.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const value = textDecoder.decode(bytes);
    if (value.length === 0) throw new Error("empty");
    return value;
  } catch {
    throw new Error("invalid password token");
  }
}
