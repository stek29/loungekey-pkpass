import { createHash } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const logoUrl = requiredEnvironmentVariable("LOUNGEKEY_LOGO_URL");
const expectedHash = requiredEnvironmentVariable(
  "LOUNGEKEY_LOGO_SHA256",
).toLowerCase();

if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
  throw new Error("LOUNGEKEY_LOGO_SHA256 must be a SHA-256 hex digest");
}

const url = new URL(logoUrl);
if (url.protocol !== "https:") {
  throw new Error("LOUNGEKEY_LOGO_URL must use HTTPS");
}

const outputDirectory = new URL("../.assets.deploy/", import.meta.url);
const defaultAssets = new URL("../assets/default/", import.meta.url);
const cacheKey = createHash("sha256")
  .update(`${url.href}\0${expectedHash}`)
  .digest("hex");
const npmCache = process.env.npm_config_cache || join(homedir(), ".npm");
const logoCache = join(npmCache, "loungekey-pkpass-assets", cacheKey);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  cp(new URL("icon.png", defaultAssets), new URL("icon.png", outputDirectory)),
  cp(
    new URL("icon@2x.png", defaultAssets),
    new URL("icon@2x.png", outputDirectory),
  ),
]);

if (await restoreCachedLogos(logoCache, outputDirectory)) {
  console.log(`restored verified Worker logos from build cache ${cacheKey}`);
} else {
  const logoSvg = await downloadLogo(url);
  const actualHash = createHash("sha256").update(logoSvg).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `logo SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`,
    );
  }

  await Promise.all([
    renderLogo(logoSvg, 160, 58, new URL("logo.png", outputDirectory)),
    renderLogo(logoSvg, 320, 116, new URL("logo@2x.png", outputDirectory)),
  ]);
  await cacheLogos(logoCache, outputDirectory);
  console.log(`prepared Worker assets from verified logo ${actualHash}`);
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function downloadLogo(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`logo download failed with HTTP ${response.status}`);
  }
  const logo = Buffer.from(await response.arrayBuffer());
  if (logo.length === 0 || logo.length > 5 * 1024 * 1024) {
    throw new Error("downloaded logo has an invalid size");
  }
  return logo;
}

async function restoreCachedLogos(cache, output) {
  try {
    await Promise.all([
      copyAndValidateLogo(
        join(cache, "logo.png"),
        new URL("logo.png", output),
        160,
        58,
      ),
      copyAndValidateLogo(
        join(cache, "logo@2x.png"),
        new URL("logo@2x.png", output),
        320,
        116,
      ),
    ]);
    return true;
  } catch {
    await Promise.all([
      rm(new URL("logo.png", output), { force: true }),
      rm(new URL("logo@2x.png", output), { force: true }),
    ]);
    return false;
  }
}

async function copyAndValidateLogo(source, destination, width, height) {
  await cp(source, destination);
  const metadata = await sharp(fileURLToPath(destination)).metadata();
  if (metadata.width !== width || metadata.height !== height) {
    throw new Error("cached logo has invalid dimensions");
  }
}

async function cacheLogos(cache, output) {
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  await Promise.all([
    cp(new URL("logo.png", output), join(cache, "logo.png")),
    cp(new URL("logo@2x.png", output), join(cache, "logo@2x.png")),
  ]);
}

async function renderLogo(source, width, height, destination) {
  await sharp(source, { density: 384 })
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(fileURLToPath(destination));
}
