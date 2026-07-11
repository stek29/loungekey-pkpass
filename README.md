# LoungeKey pkpass Generator

A Go application that generates unsigned, updateable `.pkpass` files from a
LoungeKey account for compatible Android wallet applications. Apple Wallet
rejects unsigned passes.

## Why this exists

LoungeKey does not provide a convenient way to keep multiple accounts available
and switch between them without signing out and signing back in. This project
was created to explore using separate wallet passes as a more convenient way to
keep multiple accounts accessible.

## Disclaimer

This independent project was created for educational and research purposes. It
is not affiliated with, endorsed by, or sponsored by Lounge Key Limited,
Collinson Group, or any of their affiliates. LoungeKey and associated marks
belong to their respective owners. No third-party logos or other trademark
assets are included.

The BSD Zero Clause License covers this project's code only. It does not grant
permission to access any third-party service, automate an account, reproduce
branded assets, or use a wallet pass for lounge entry. Users are responsible
for complying with the terms that apply to their accounts and services.

## Build

```bash
go build -o loungekey-pass ./cmd/loungekey-pass
```

QR decoding is implemented in the application; no external QR-decoding program
or service is required.

## Generate a pass

Create a credentials file named `account1.env`:

```dotenv
LOUNGEKEY_LOGIN=your_username
LOUNGEKEY_PASSWORD=your_password
```

Generate a regular pass:

```bash
./loungekey-pass generate -o lounge-access.pkpass
```

Generate an updateable pass:

```bash
./loungekey-pass generate \
  --web-service-url https://passes.example.com \
  -o lounge-access.pkpass
```

Use `--env-file` to select another credentials file. Manual mode is available
with `--manual` and requires `--name`, `--lounge-number`, `--card-last4`,
`--expiration`, `--date-added`, and `--qr-message`.

## Update server

```bash
./loungekey-pass serve --host 0.0.0.0 --port 8080
```

Open the server root to generate the first pass without using the CLI:

```text
https://passes.example.com/
```

The page is a plain HTML form without JavaScript. The server signs in to
LoungeKey and returns a `.pkpass` whose `webServiceURL` matches the request
origin. It does not retain credentials in a database or on disk.

For passes generated or refreshed by the server, `webServiceURL` is derived
from the incoming request. Behind a reverse proxy, the server uses
`X-Forwarded-Proto` and `X-Forwarded-Host`. Configure the proxy to overwrite
these headers rather than accepting client-supplied values. CLI generation uses
the explicit value supplied through `--web-service-url`.

The wallet refresh endpoint is:

```text
GET /v1/passes/pass.rocks.stek29.lounge-access/{username}
```

The username is stored as the pass `serialNumber`. The password is encoded with
base64url and stored as the pass `authenticationToken`, then sent in the
standard `Authorization: ApplePass ...` header.

> [!WARNING]
> Base64url is encoding, not encryption. Anyone who obtains an updateable pass
> can recover its LoungeKey password. Do not share generated passes, and expose
> the update server only over HTTPS.

Health check: `GET /healthz`.

## Pass metadata

The default metadata is neutral and independent:

```text
passTypeIdentifier = pass.rocks.stek29.lounge-access
organizationName   = stek29
description        = Lounge Access Pass
teamIdentifier     = XXXXXXXXXX
```

Before signing a pass for Apple Wallet, provide a real Team ID and Pass Type ID
through `PASS_TEAM_IDENTIFIER` and `PASS_TYPE_IDENTIFIER`. The server also
supports `PASS_ORGANIZATION_NAME` and `PASS_DESCRIPTION`. For CLI generation,
the corresponding flags are `--team-identifier`, `--pass-type-identifier`,
`--organization-name`, and `--pass-description`.

## Custom assets

By default, the application generates neutral assets and does not download or
include third-party logos. Supply a directory of custom pass assets with
`--assets`. The server also reads the directory from `PASS_ASSETS_DIR`.

Only use assets you have permission to use. The server does not download or
cache them.

For example, the following commands prepare a custom asset directory using the
logo currently served by LoungeKey's website. This is optional and requires
`curl` and ImageMagick:

```bash
mkdir -p assets
curl --fail --location \
  'https://d25xpw488bmti5.cloudfront.net/Default/Shared/DevDemo/Global/Logos/LK-logo-small-31f0203d-5bd1-4186-97cd-d4bcc6050043.webp?h=73&la=en&w=200' \
  --output /tmp/loungekey-logo.webp

magick -size 58x58 xc:none assets/icon.png
magick -size 116x116 xc:none assets/icon@2x.png
magick -size 375x3 'xc:#009245' assets/strip.png
magick -size 750x6 'xc:#009245' assets/strip@2x.png
magick /tmp/loungekey-logo.webp -resize '160x58>' -gravity center \
  -background none -extent 160x58 assets/logo.png
magick /tmp/loungekey-logo.webp -resize '320x116>' -gravity center \
  -background none -extent 320x116 assets/logo@2x.png
rm /tmp/loungekey-logo.webp
```

The external URL and image are controlled by their owner and may change or
disappear. The project's license does not cover the downloaded image; confirm
that your intended use is permitted.

Use the directory with a local server:

```bash
./loungekey-pass serve --assets ./assets --host 0.0.0.0 --port 8080
```

Example with Docker:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/assets:/assets:ro" \
  -e PASS_ASSETS_DIR=/assets \
  loungekey-pkpass
```

## Docker

```bash
docker build -t loungekey-pkpass .
docker run --rm -p 8080:8080 loungekey-pkpass
```

The form is then available at `http://localhost:8080/`. When deploying behind a
reverse proxy, forward sanitized `X-Forwarded-Proto` and `X-Forwarded-Host`
headers so generated passes contain the external HTTPS origin.

GitHub Actions tests the Go code and container build for pull requests and for
pushes to `main` or `master`. Pushes to `main`/`master` and tags matching `v*`
publish a multi-architecture image to `ghcr.io/stek29/loungekey-pkpass` with
`latest`, semantic-version, and `sha-*` tags as applicable.

## License

The project is licensed under the [BSD Zero Clause License](LICENSE).

## Third-party notices

The application uses the following third-party Go modules:

- [goquery](https://github.com/PuerkitoBio/goquery), copyright Martin Angers
  and contributors, licensed under the BSD 3-Clause License.
- [Cascadia](https://github.com/andybalholm/cascadia), copyright Andy Balholm,
  licensed under the BSD 3-Clause License.
- [Go supplementary network libraries](https://github.com/golang/net),
  copyright The Go Authors, licensed under the BSD 3-Clause License.
- [gozxing](https://github.com/makiuchi-d/gozxing), copyright Daisuke Makiuchi
  and contributors, licensed under the MIT License.

The module versions used by a particular build are recorded in `go.mod` and
`go.sum`. These dependencies are not relicensed under the project's BSD Zero
Clause License; their respective license terms continue to apply.
