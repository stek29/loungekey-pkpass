# LoungeKey pkpass Generator

Генератор неподписанных `.pkpass` файлов для LoungeKey.

> ⚠️ Apple Wallet отклонит неподписанный pass. Для iOS нужен подписанный сертификат Pass Type ID + Apple WWDR. На Android обычно работает с PassWallet / WalletPasses.

## Установка

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install Pillow
sudo apt install zbar-tools
```

## Использование

Автоматически загрузить актуальные данные и QR-код с LoungeKey:

```bash
python3 generate.py --env-file account1.env -o loungekey.pkpass
```

Для Android wallet с поддержкой стандартного PassKit web service добавьте URL
сервера обновлений:

```bash
python3 generate.py \
  --env-file account1.env \
  --web-service-url https://passes.example.com \
  -o loungekey.pkpass
```

Запуск stateless-сервера:

```bash
PASS_SERVER_URL=https://passes.example.com python3 server.py --host 0.0.0.0 --port 8080
```

Wallet запрашивает `GET /v1/passes/pass.com.loungekey.membership/{username}`.
Username хранится как `serialNumber`, а пароль передаётся в стандартном заголовке
`Authorization: ApplePass …` в base64url-кодировке. Сервер ничего не сохраняет.

Файл учётных данных:

```dotenv
LOUNGEKEY_LOGIN=your_username
LOUNGEKEY_PASSWORD=your_password
```

Генератор создаёт новую авторизованную сессию при каждом запуске, загружает страницу
аккаунта и декодирует текущий QR-код. Для периодического обновления запускайте эту же
команду из cron/systemd timer. Сам `.pkpass` не может измениться после установки без
Apple PassKit web service и подписи.

Ручной режим:

```bash
python3 generate.py \
  --manual \
  --name "Mr. Soltan Tekeev" \
  --lounge-number "1400xxxxxx" \
  --card-last4 "1234" \
  --expiration "2031-06-30" \
  --date-added "2026-07-09" \
  --qr-message "ТЕКСТ_ИЗ_QR_КОДА" \
  -o loungekey.pkpass
```

## Параметры

| Параметр | Описание |
|----------|----------|
| `--env-file` | Файл с `LOUNGEKEY_LOGIN` и `LOUNGEKEY_PASSWORD` (по умолчанию `account1.env`) |
| `--manual` | Не обращаться к LoungeKey; использовать переданные вручную поля |
| `--web-service-url` | Публичный URL stateless-сервера обновлений |
| `--name` | Имя владельца |
| `--lounge-number` | Lounge Access Number |
| `--card-last4` | Последние 4 цифры карты |
| `--expiration` | Дата истечения карты, `YYYY-MM-DD` |
| `--date-added` | Дата добавления карты, `YYYY-MM-DD` |
| `--qr-message` | Текст, закодированный в QR-код |
| `--assets` | Папка с кастомными `icon.png`, `logo.png`, `strip.png` |
| `-o, --output` | Путь к выходному `.pkpass` |

## Логотип

Файлы `default_logo.png` и `default_logo@2x.png` содержат товарный знак **LoungeKey** и используются только для генерации персонального passes для владельцев карт LoungeKey. Логотип и товарный знак принадлежат LoungeKey Limited / Collinson Group. Этот проект не связан с LoungeKey и не претендует на право собственности на логотип.

## Лицензия

См. [LICENSE](LICENSE). Логотип LoungeKey не покрывается лицензией кода.
