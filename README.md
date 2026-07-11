# LoungeKey pkpass Generator

A TypeScript service that generates unsigned, updateable `.pkpass` files from a
LoungeKey account for compatible Android wallet applications. It runs on
Cloudflare Workers or as a standalone Node.js Docker container. Apple Wallet
rejects unsigned passes.

## Disclaimer

This independent project was created for educational and research purposes. It
is not affiliated with, endorsed by, or sponsored by Lounge Key Limited,
Collinson Group, or any of their affiliates. LoungeKey and associated marks
belong to their respective owners. No third-party logos or trademark assets are
distributed with this project.

The BSD Zero Clause License covers this project's code only. It does not grant
permission to access a third-party service, automate an account, reproduce
branded assets, or use a wallet pass for lounge entry. Users are responsible for
complying with the terms that apply to their accounts and services.

## How it works

Open the service root and submit the HTML-only username/password form. The
service signs in to LoungeKey and returns a `.pkpass` containing the current QR
code and its own refresh URL. The form displays the same `logo.png` asset that
will be embedded in the generated pass.

The wallet refresh endpoint is:

```text
GET /v1/passes/{passTypeIdentifier}/{username}
Authorization: ApplePass {base64url-password}
```

The username is the pass `serialNumber`. The base64url-encoded password is the
pass `authenticationToken`. The service is stateless and does not store either
credential, but anyone who obtains the pass can recover its password. Use HTTPS
and never share generated passes.

Generated pass responses are marked `private` and `no-store` for clients,
proxies, and Cloudflare so every refresh reaches LoungeKey. Health check:
`GET /healthz`.

Known LoungeKey benefit packages also add entitlement and visit summaries to
the back of the pass. LoungeKey notes that visit history can take 3–5 days to
appear and only includes the last 18 months. Unknown packages skip these
optional requests and still produce a basic pass.

## Cloudflare Workers

Requirements: Node.js 24 LTS, npm, and an authenticated Wrangler installation.

```bash
npm ci
npm run check
npm test
npm run test:worker
npm run deploy -- --name <worker-name>
```

The tracked Wrangler configuration contains no account ID, Worker name, route,
domain, or credential. Wrangler deploys to the account selected by the invoking
user. The Worker name is always supplied on the command line.

Pass metadata can be configured as Worker variables:

```text
PASS_TYPE_IDENTIFIER
PASS_TEAM_IDENTIFIER
PASS_ORGANIZATION_NAME
PASS_DESCRIPTION
PASS_FOREGROUND_COLOR
PASS_BACKGROUND_COLOR
PASS_LABEL_COLOR
```

Colors use Wallet's `rgb(red, green, blue)` notation with channels from 0 to
255.

No database, KV namespace, R2 bucket, Durable Object, or secret is required.

## Docker

Build and run the Node.js 24 LTS image:

```bash
docker build -t loungekey-pkpass .
docker run --rm -p 8080:8080 loungekey-pkpass
```

Configuration:

```text
HOST                       default: 0.0.0.0
PORT                       default: 8080
TRUST_PROXY                default: false
PASS_ASSETS_DIR            default: /app/assets/default
PASS_TYPE_IDENTIFIER       default: pass.rocks.stek29.lounge-access
PASS_TEAM_IDENTIFIER       default: XXXXXXXXXX
PASS_ORGANIZATION_NAME     default: stek29
PASS_DESCRIPTION           default: Lounge Access Pass
PASS_FOREGROUND_COLOR      default: rgb(52, 73, 94)
PASS_BACKGROUND_COLOR      default: rgb(255, 255, 255)
PASS_LABEL_COLOR           default: rgb(52, 73, 94)
```

The public `webServiceURL` comes from the incoming request. When Docker runs
behind a trusted reverse proxy, set `TRUST_PROXY=true` and configure the proxy
to overwrite `X-Forwarded-Host` and `X-Forwarded-Proto`. Never pass through
client-supplied forwarded headers.

## Pass assets

The repository contains neutral project-owned assets in `assets/default`.
Passes contain `icon.png`, `icon@2x.png`, `logo.png`, and `logo@2x.png`; strip
images are neither accepted nor generated.

### Optional LoungeKey logo

The following optional example downloads the logo referenced by Collinson's
official website and creates an untracked `.assets.local` directory. It requires
`curl` and ImageMagick. The downloaded artwork is controlled by its owner, is
not distributed by this project, and is not covered by this project's license.
Confirm that your intended use is permitted.

The explicit input density makes ImageMagick rasterize the SVG above the
largest output size before downsampling, avoiding a blurry enlarged logo.

```bash
rm -rf .assets.local
mkdir .assets.local
cp assets/default/icon.png assets/default/icon@2x.png .assets.local/

curl --fail --location \
  'https://images.ctfassets.net/ibqmfcvkfft1/7yesdYfEm4oL7HlMgQ6lMY/626632627bcf816e2cba2d013de60e4d/LoungeKey_103x32.svg' \
  --output /tmp/loungekey-logo.svg

magick -density 384 -background none /tmp/loungekey-logo.svg -alpha on \
  -resize '160x58' -gravity center -extent 160x58 .assets.local/logo.png
magick -density 384 -background none /tmp/loungekey-logo.svg -alpha on \
  -resize '320x116' -gravity center -extent 320x116 .assets.local/logo@2x.png
rm /tmp/loungekey-logo.svg
```

Deploy the Worker with those untracked assets:

```bash
npm run deploy -- --name <worker-name> --assets ./.assets.local
```

Mount the same directory into Docker:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/.assets.local:/pass-assets:ro" \
  -e PASS_ASSETS_DIR=/pass-assets \
  loungekey-pkpass
```

## Development

```bash
npm ci
npm run check
npm test
npm run test:worker
npm run deploy -- --name dry-run --dry-run
```

The test suite uses harmless local HTML and JPEG QR fixtures. Live credentials
and generated passes are ignored by Git. Pushes and pull requests run type,
format, lint, Node/workerd, dependency-audit, Worker-bundle, and Docker checks.
Default-branch and version-tag pushes continue publishing multi-architecture
Docker images to GHCR.

## License

The project is licensed under the [BSD Zero Clause License](LICENSE).

Runtime dependencies and bundled components retain their own licenses:

- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm): MIT; its bundled
  ZXing-C++ code is Apache-2.0 and Zint components are BSD 3-Clause.
- [fflate](https://github.com/101arrowz/fflate): MIT.
- [htmlparser2](https://github.com/fb55/htmlparser2): MIT.

Exact direct and transitive versions are recorded in `package-lock.json` and
are not relicensed under the project's BSD Zero Clause License.
