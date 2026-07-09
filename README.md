# LoungeKey pkpass Generator

Генератор неподписанных `.pkpass` файлов для LoungeKey.

> ⚠️ Apple Wallet отклонит неподписанный pass. Для iOS нужен подписанный сертификат Pass Type ID + Apple WWDR. На Android обычно работает с PassWallet / WalletPasses.

## Установка

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install Pillow
```

## Использование

```bash
python3 generate.py \
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
