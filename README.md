# LoungeKey pkpass Generator

Go-приложение для создания и автоматического обновления неподписанных LoungeKey `.pkpass` на Android. Apple Wallet отклоняет неподписанные passes.

## Сборка

```bash
go build -o loungekey-pass ./cmd/loungekey-pass
```

Внешние программы и сервисы для декодирования QR не нужны.

## Генерация

Файл учётных данных (по умолчанию `account1.env`):

```dotenv
LOUNGEKEY_LOGIN=your_username
LOUNGEKEY_PASSWORD=your_password
```

Создать обычный pass:

```bash
./loungekey-pass generate -o loungekey.pkpass
```

Создать обновляемый pass:

```bash
./loungekey-pass generate \
  --web-service-url https://passes.example.com \
  -o loungekey.pkpass
```

Можно указать другой файл через `--env-file`. Ручной режим доступен через `--manual` и поля `--name`, `--lounge-number`, `--card-last4`, `--expiration`, `--date-added`, `--qr-message`.

## Сервер обновлений

```bash
./loungekey-pass serve --host 0.0.0.0 --port 8080
```

Wallet запрашивает `GET /v1/passes/pass.rocks.stek29.lounge-access/{username}`. Username хранится как `serialNumber`, пароль — в стандартном заголовке `Authorization: ApplePass …` в base64url. Сервер stateless и ничего не сохраняет.

`webServiceURL` всегда определяется из origin входящего HTTP-запроса. За reverse proxy сервер использует `X-Forwarded-Proto` и `X-Forwarded-Host`; отдельная настройка публичного URL не требуется.

Откройте корень сервера в браузере, чтобы создать первый pass без CLI:

```text
https://passes.example.com/
```

Страница содержит обычную HTML-форму без JavaScript. После отправки сервер входит в LoungeKey и возвращает `.pkpass`; его `webServiceURL` автоматически совпадает с HTTP origin страницы. Логин и пароль не сохраняются.

Проверка состояния: `GET /healthz`.

## Метаданные pass

По умолчанию используются независимые идентификаторы и нейтральный branding:

```text
passTypeIdentifier = pass.rocks.stek29.lounge-access
organizationName   = stek29
description        = Lounge Access Pass
teamIdentifier     = XXXXXXXXXX
```

Перед Apple signing задайте настоящий Team ID и Pass Type ID через `PASS_TEAM_IDENTIFIER` и `PASS_TYPE_IDENTIFIER`. Также доступны `PASS_ORGANIZATION_NAME` и `PASS_DESCRIPTION`. Для CLI каждому значению соответствует флаг `--team-identifier`, `--pass-type-identifier`, `--organization-name` или `--pass-description`.

### Опциональный официальный логотип

По умолчанию приложение не загружает и не включает сторонние логотипы. Кастомные pass assets можно подготовить отдельно и передать через `--assets` или `PASS_ASSETS_DIR`. Сервер не скачивает их и не управляет кешем.

Пример подготовки assets с логотипом, который сейчас используется официальным сайтом LoungeKey (нужны `curl` и ImageMagick):

```bash
mkdir -p assets
curl --fail --location \
  'https://d25xpw488bmti5.cloudfront.net/Default/Shared/DevDemo/Global/Logos/LK-logo-small-31f0203d-5bd1-4186-97cd-d4bcc6050043.webp?h=73&la=en&w=200' \
  --output /tmp/loungekey-logo.webp

magick -size 58x58 xc:none assets/icon.png
magick -size 116x116 xc:none assets/icon@2x.png
magick -size 375x3 'xc:#009245' assets/strip.png
magick -size 750x6 'xc:#009245' assets/strip@2x.png
magick /tmp/loungekey-logo.webp -resize '160x58>' -gravity center -background none -extent 160x58 assets/logo.png
magick /tmp/loungekey-logo.webp -resize '320x116>' -gravity center -background none -extent 320x116 assets/logo@2x.png
rm /tmp/loungekey-logo.webp
```

Использование с локальным сервером:

```bash
./loungekey-pass serve --assets ./assets --host 0.0.0.0 --port 8080
```

Или с Docker:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/assets:/assets:ro" \
  -e PASS_ASSETS_DIR=/assets \
  loungekey-pkpass
```

Внешний URL и изображение контролируются их владельцем и могут измениться. LoungeKey является товарным знаком соответствующего правообладателя. Проект независим и не связан с LoungeKey, не одобрен и не спонсируется им.

## Docker

Собрать и запустить контейнер:

```bash
docker build -t loungekey-pkpass .
docker run --rm -p 8080:8080 loungekey-pkpass
```

После запуска форма доступна на `http://localhost:8080/`. Для работы за reverse proxy передавайте `X-Forwarded-Proto` и `X-Forwarded-Host`, чтобы pass получил внешний HTTPS origin.

GitHub Actions проверяет Go-код и сборку контейнера для каждого push/PR. Push в `main`/`master` и теги `v*` публикуют multi-arch образ в `ghcr.io/stek29/loungekey-pkpass` с тегами `latest`, semver и `sha-*`.

## Лицензия

См. [LICENSE](LICENSE).
