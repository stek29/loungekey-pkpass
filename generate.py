#!/usr/bin/env python3
"""
Генератор неподписанного .pkpass для LoungeKey.
Apple Wallet отклонит (нет подписи), но Android pass-ридеры (PassWallet, WalletPasses)
откроют.

QR-код генерируется самим wallet-приложением из barcode.message.
"""

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime


GREEN = (0, 146, 69)
DARK_TEXT = "rgb(52, 73, 94)"
WHITE = "rgb(255, 255, 255)"


def format_date(value: str) -> str:
    """Принимает YYYY-MM-DD, возвращает ISO 8601 для Apple Wallet date field."""
    dt = datetime.strptime(value, "%Y-%m-%d")
    return dt.strftime("%Y-%m-%dT00:00:00Z")


def format_date_field(key: str, label: str, iso_value: str) -> dict:
    return {
        "key": key,
        "label": label,
        "value": iso_value,
        "dateStyle": "PKDateStyleMedium",
        "timeStyle": "PKDateStyleNone",
        "textAlignment": "PKTextAlignmentCenter",
        "ignoresTimeZone": True,
    }


def mask_card(last4: str) -> str:
    """Принимает 4 последние цифры, возвращает '************1234'."""
    last4 = last4.strip()
    if not last4.isdigit() or len(last4) != 4:
        raise ValueError("--card-last4 must be exactly 4 digits")
    return f"************{last4}"


def short_card(last4: str) -> str:
    """Для header: '•1234'."""
    last4 = last4.strip()
    if not last4.isdigit() or len(last4) != 4:
        raise ValueError("--card-last4 must be exactly 4 digits")
    return f"•{last4}"


# ===== Базовый pass.json =====
def make_pass_json(
    name: str,
    lounge_number: str,
    card_last4: str,
    expiration_date: str,
    date_added: str,
    qr_message: str,
) -> dict:
    card_on_file = mask_card(card_last4)
    card_header = short_card(card_last4)
    expiration = format_date(expiration_date)
    added = format_date(date_added)

    return {
        "description": "LoungeKey Membership",
        "formatVersion": 1,
        "organizationName": "LoungeKey",
        "passTypeIdentifier": "pass.com.loungekey.membership",
        "serialNumber": lounge_number,
        "teamIdentifier": "XXXXXXXXXX",
        "foregroundColor": DARK_TEXT,
        "backgroundColor": WHITE,
        "labelColor": DARK_TEXT,
        "logoText": "",
        "barcode": {
            "message": qr_message,
            "format": "PKBarcodeFormatQR",
            "messageEncoding": "iso-8859-1",
        },
        "generic": {
            "headerFields": [
                {
                    "key": "cardOnFile",
                    "label": "Card on File",
                    "value": card_header,
                }
            ],
            "primaryFields": [
                {
                    "key": "memberName",
                    "label": "Member",
                    "value": name,
                    "textAlignment": "PKTextAlignmentCenter",
                }
            ],
            "secondaryFields": [
                {
                    "key": "loungeNumber",
                    "label": "Lounge Access Number",
                    "value": lounge_number,
                    "textAlignment": "PKTextAlignmentCenter",
                },
                format_date_field("expiration", "Card Expiration Date", expiration),
                format_date_field("dateAdded", "Date Card Added", added),
            ],
        },
    }


# ===== Манифест =====
def make_manifest(files_dir: str) -> dict:
    manifest = {}
    for name in sorted(os.listdir(files_dir)):
        path = os.path.join(files_dir, name)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                manifest[name] = hashlib.sha256(f.read()).hexdigest()
    return manifest


# ===== Создание изображений =====
def create_assets(assets_dir: str, script_dir: str | None = None):
    """Создаёт icon.png, logo.png, strip.png. Использует настоящий LoungeKey логотип, если есть."""
    from PIL import Image

    if script_dir is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))

    def save(img: Image.Image, filename: str):
        img.save(os.path.join(assets_dir, filename), "PNG")

    # icon.png / icon@2x.png
    icon = Image.new("RGBA", (58, 58), (255, 255, 255, 0))
    save(icon, "icon.png")
    icon2x = Image.new("RGBA", (116, 116), (255, 255, 255, 0))
    save(icon2x, "icon@2x.png")

    # logo.png / logo@2x.png — настоящий LoungeKey логотип
    logo_path = os.path.join(script_dir, "default_logo.png")
    logo2x_path = os.path.join(script_dir, "default_logo@2x.png")
    if os.path.exists(logo_path):
        shutil.copy(logo_path, os.path.join(assets_dir, "logo.png"))
    else:
        logo = Image.new("RGBA", (160, 58), (255, 255, 255, 0))
        save(logo, "logo.png")
    if os.path.exists(logo2x_path):
        shutil.copy(logo2x_path, os.path.join(assets_dir, "logo@2x.png"))
    else:
        logo2x = Image.new("RGBA", (320, 116), (255, 255, 255, 0))
        save(logo2x, "logo@2x.png")

    # strip.png — зелёная линия-разделитель
    strip = Image.new("RGBA", (375, 3), GREEN + (255,))
    save(strip, "strip.png")
    save(strip.resize((750, 6), Image.LANCZOS), "strip@2x.png")


# ===== Сборка pkpass =====
def build_pkpass(pass_json: dict, out_path: str, assets_dir: str | None = None):
    with tempfile.TemporaryDirectory() as tmp:
        pass_path = os.path.join(tmp, "pass.json")
        with open(pass_path, "w", encoding="utf-8") as f:
            json.dump(pass_json, f, ensure_ascii=False, indent=2)

        if assets_dir and os.path.isdir(assets_dir):
            shutil.copytree(assets_dir, os.path.join(tmp, "assets"))
        else:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            os.makedirs(os.path.join(tmp, "assets"))
            create_assets(os.path.join(tmp, "assets"), script_dir=script_dir)

        manifest = make_manifest(tmp)
        with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(os.path.join(tmp, "pass.json"), "pass.json")
            zf.write(os.path.join(tmp, "manifest.json"), "manifest.json")
            assets = os.path.join(tmp, "assets")
            for name in os.listdir(assets):
                zf.write(os.path.join(assets, name), name)


# ===== CLI =====
def main():
    parser = argparse.ArgumentParser(description="Generate unsigned LoungeKey pkpass")
    parser.add_argument("--name", default="Member", help="Имя владельца")
    parser.add_argument("--lounge-number", required=True, help="Lounge Access Number")
    parser.add_argument("--card-last4", required=True, help="Последние 4 цифры карты (XXXX)")
    parser.add_argument("--expiration", required=True, help="Срок действия карты, YYYY-MM-DD")
    parser.add_argument("--date-added", required=True, help="Дата добавления карты, YYYY-MM-DD")
    parser.add_argument("--qr-message", required=True, help="Текст, закодированный в QR")
    parser.add_argument("--assets", help="Папка с icon.png, logo.png, strip.png")
    parser.add_argument("-o", "--output", required=True, help="Путь к .pkpass")
    args = parser.parse_args()

    pass_json = make_pass_json(
        name=args.name,
        lounge_number=args.lounge_number,
        card_last4=args.card_last4,
        expiration_date=args.expiration,
        date_added=args.date_added,
        qr_message=args.qr_message,
    )
    build_pkpass(pass_json, args.output, args.assets)
    print(f"Created: {args.output}")


if __name__ == "__main__":
    main()
