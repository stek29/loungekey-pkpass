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
service signs in through the LoungeKey mobile API and returns a `.pkpass`
containing the current digital membership barcode and its own refresh URL. Pass
artwork is embedded only in generated passes and is not displayed or served by
the landing page.

The wallet refresh endpoint is:

```text
GET /v1/passes/{passTypeIdentifier}/{username}
Authorization: ApplePass v2.{base64url-credentials}
```

The username is the pass `serialNumber`. The versioned pass
`authenticationToken` contains the mobile bearer token, its expiration time,
and the account password. A valid bearer token is reused. When it expires or
the API rejects it, the password is hashed as required by the current mobile
login API and used to authenticate again. The returned pass contains the
replacement token.

The service is stateless and does not store these credentials, but anyone who
obtains the pass can recover its password and access the account. Use HTTPS and
never share generated passes. Passes made by versions of this project that used
the unprefixed base64url password format are recognized and upgraded to the
versioned format during their next refresh.

Generated pass responses are marked `private` and `no-store` for clients,
proxies, and Cloudflare so every refresh reaches LoungeKey. Health check:
`GET /healthz`.

The mobile allocation and visit APIs add entitlement and visit summaries to the
back of the pass when available. Optional allocation or history failures still
produce a basic pass.

## Cloudflare Workers

Requirements: Node.js 24 LTS, npm, and an authenticated Wrangler installation.

```bash
npm ci
npm run check
npm test
npm run test:worker
npm run build:cloudflare
npm run deploy
```

The tracked Wrangler configuration names the Worker `zal-pass` and contains no
account ID, route, custom domain, or credential. Wrangler deploys to the account
selected by the invoking user.

`npm run build:cloudflare` must run before every deploy because Wrangler serves
static assets from the generated `.assets.deploy/` directory. Run it without the
LoungeKey logo environment variables to produce the neutral default assets, or
with them to render the official branded logos.

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

### Cloudflare Builds deployment

The production GitHub Actions job calls a Worker-specific Cloudflare deploy
hook after the test and Docker jobs pass. Configure the connected Worker's
build settings as follows:

```text
Build command:  npm run build:cloudflare
Deploy command: npm run deploy
Node version:   24
```

Add these Cloudflare build variables:

```text
PASS_LOGO_URL             HTTPS URL of an optional SVG logo
NODE_VERSION              24
```

`build:cloudflare` generates assets in `.assets.deploy`. If `PASS_LOGO_URL` is
set, the SVG is rendered to both PNG logo sizes; otherwise the neutral default
logos are copied. If the remote logo cannot be fetched or rendered, the build
falls back to the default assets.

Enable the Worker project's build cache so Cloudflare preserves the npm
dependencies cache between builds.

Create a deploy hook for the production branch and save its complete URL as the
`CLOUDFLARE_DEPLOY_HOOK` secret in a GitHub environment named `production`.
GitHub receives no account-wide Cloudflare API token.

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

### Optional logo

Set `PASS_LOGO_URL` before running `npm run build:cloudflare` to render an
optional logo from an HTTPS SVG URL:

```text
PASS_LOGO_URL             HTTPS URL of an optional SVG logo
```

The downloaded artwork is controlled by its owner, is not distributed by this
project, and is not covered by this project's license. Confirm that your intended
use is permitted.

```bash
PASS_LOGO_URL='https://example.com/logo.svg' \
npm run build:cloudflare
npm run deploy
```

Mount the same generated assets into Docker:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/.assets.local:/pass-assets:ro" \
  -e PASS_ASSETS_DIR=/pass-assets \
  loungekey-pkpass
```

### Local assets without Cloudflare Builds

For local development or Docker, you can also use the `.assets.local`
directory directly. Run `npm run build:cloudflare` and then copy the generated
files to `.assets.local`, or set `PASS_LOGO_URL` and point Docker at the
resulting `.assets.deploy/` directory.

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

- [fflate](https://github.com/101arrowz/fflate): MIT.

Exact direct and transitive versions are recorded in `package-lock.json` and
are not relicensed under the project's BSD Zero Clause License.
