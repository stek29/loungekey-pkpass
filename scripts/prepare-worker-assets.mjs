import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const logoUrl = process.env.PASS_LOGO_URL?.trim();

const outputDirectory = new URL("../.assets.deploy/", import.meta.url);
const defaultAssets = new URL("../assets/default/", import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  cp(new URL("icon.png", defaultAssets), new URL("icon.png", outputDirectory)),
  cp(
    new URL("icon@2x.png", defaultAssets),
    new URL("icon@2x.png", outputDirectory),
  ),
]);

if (logoUrl) {
  try {
    const url = new URL(logoUrl);
    if (url.protocol !== "https:") {
      throw new Error("PASS_LOGO_URL must use HTTPS");
    }

    const logoSvg = await downloadLogo(url);
    await Promise.all([
      renderLogo(logoSvg, 160, 58, new URL("logo.png", outputDirectory)),
      renderLogo(logoSvg, 320, 116, new URL("logo@2x.png", outputDirectory)),
    ]);
    console.log("prepared Worker assets from remote logo");
  } catch (error) {
    console.warn(
      `failed to render remote logo, using default assets: ${error.message}`,
    );
    await Promise.all([
      cp(
        new URL("logo.png", defaultAssets),
        new URL("logo.png", outputDirectory),
      ),
      cp(
        new URL("logo@2x.png", defaultAssets),
        new URL("logo@2x.png", outputDirectory),
      ),
    ]);
  }
} else {
  await Promise.all([
    cp(
      new URL("logo.png", defaultAssets),
      new URL("logo.png", outputDirectory),
    ),
    cp(
      new URL("logo@2x.png", defaultAssets),
      new URL("logo@2x.png", outputDirectory),
    ),
  ]);
  console.log("prepared default Worker assets (no remote logo configured)");
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

async function renderLogo(source, width, height, destination) {
  await sharp(source, { density: 384 })
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(fileURLToPath(destination));
}
