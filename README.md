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

Wallet запрашивает `GET /v1/passes/pass.com.loungekey.membership/{username}`. Username хранится как `serialNumber`, пароль — в стандартном заголовке `Authorization: ApplePass …` в base64url. Сервер stateless и ничего не сохраняет.

`webServiceURL` всегда определяется из origin входящего HTTP-запроса. За reverse proxy сервер использует `X-Forwarded-Proto` и `X-Forwarded-Host`; отдельная настройка публичного URL не требуется.

Откройте корень сервера в браузере, чтобы создать первый pass без CLI:

```text
https://passes.example.com/
```

Страница содержит обычную HTML-форму без JavaScript. После отправки сервер входит в LoungeKey и возвращает `.pkpass`; его `webServiceURL` автоматически совпадает с HTTP origin страницы. Логин и пароль не сохраняются.

Проверка состояния: `GET /healthz`.

## Docker

Собрать и запустить контейнер:

```bash
docker build -t loungekey-pkpass .
docker run --rm -p 8080:8080 loungekey-pkpass
```

После запуска форма доступна на `http://localhost:8080/`. Для работы за reverse proxy передавайте `X-Forwarded-Proto` и `X-Forwarded-Host`, чтобы pass получил внешний HTTPS origin.

GitHub Actions проверяет Go-код и сборку контейнера для каждого push/PR. Push в `main`/`master` и теги `v*` публикуют multi-arch образ в `ghcr.io/stek29/loungekey-pkpass` с тегами `latest`, semver и `sha-*`.

## Логотип

`default_logo.png` и `default_logo@2x.png` принадлежат LoungeKey Limited / Collinson Group, используются только для персональных passes и не покрываются лицензией проекта.

## Лицензия

См. [LICENSE](LICENSE).
