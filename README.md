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
PASS_SERVER_URL=https://passes.example.com \
  ./loungekey-pass serve --host 0.0.0.0 --port 8080
```

Wallet запрашивает `GET /v1/passes/pass.com.loungekey.membership/{username}`. Username хранится как `serialNumber`, пароль — в стандартном заголовке `Authorization: ApplePass …` в base64url. Сервер stateless и ничего не сохраняет.

Проверка состояния: `GET /healthz`.

## Логотип

`default_logo.png` и `default_logo@2x.png` принадлежат LoungeKey Limited / Collinson Group, используются только для персональных passes и не покрываются лицензией проекта.

## Лицензия

См. [LICENSE](LICENSE).
