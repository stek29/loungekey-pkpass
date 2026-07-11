#!/usr/bin/env python3
"""
Генератор неподписанного .pkpass для LoungeKey.
Apple Wallet отклонит (нет подписи), но Android pass-ридеры (PassWallet, WalletPasses)
откроют.

QR-код генерируется самим wallet-приложением из barcode.message.
"""

import argparse
import base64
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path


GREEN = (0, 146, 69)
DARK_TEXT = "rgb(52, 73, 94)"
WHITE = "rgb(255, 255, 255)"
LOGIN_URL = "https://www.loungekey.com/en/login"
LOGIN_API_URL = "https://www.loungekey.com/api/loungekey/lkaccount/login?sc_site=loungekey"


def load_env(path: str) -> dict[str, str]:
    """Load a small KEY=VALUE credentials file without modifying os.environ."""
    values = {}
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def _clean_html(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    return " ".join(html.unescape(value).split())


def _dashboard_field(page: str, label: str) -> str:
    match = re.search(
        rf"<strong>\s*{re.escape(label)}\s*</strong>(.*?)</li>",
        page,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise RuntimeError(f"LoungeKey dashboard field not found: {label}")
    return _clean_html(match.group(1))


def decode_qr_image(image_data: bytes) -> str:
    """Decode LoungeKey's embedded QR image using the zbar command line tool."""
    zbarimg = shutil.which("zbarimg")
    if not zbarimg:
        raise RuntimeError("zbarimg is required for automatic QR decoding (install zbar-tools)")
    with tempfile.NamedTemporaryFile(suffix=".jpg") as image_file:
        image_file.write(image_data)
        image_file.flush()
        result = subprocess.run(
            [zbarimg, "--quiet", "--raw", image_file.name],
            capture_output=True,
            check=False,
        )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError("Could not decode the QR image returned by LoungeKey")
    return result.stdout.rstrip(b"\r\n").decode("iso-8859-1")


def fetch_loungekey_data(username: str, password: str, timeout: int = 30) -> dict:
    """Log in to LoungeKey and extract current membership and QR data."""
    try:
        import requests
    except ImportError as exc:
        raise RuntimeError("requests is required for automatic LoungeKey updates") from exc

    session = requests.Session()
    session.headers.update({"User-Agent": "LoungeKey-pkpass-generator/1.0"})
    login_page = session.get(LOGIN_URL, timeout=timeout)
    login_page.raise_for_status()
    response = session.post(
        LOGIN_API_URL,
        json={
            "TimezoneOffset": str(round(-datetime.now().astimezone().utcoffset().total_seconds() / 60)),
            "Username": username,
            "Password": password,
        },
        headers={"X-Requested-With": "XMLHttpRequest", "Referer": LOGIN_URL},
        timeout=timeout,
    )
    response.raise_for_status()
    login_result = response.json()
    if not login_result.get("Success") or not login_result.get("RedirectUrl"):
        errors = login_result.get("Errors") or ["login failed"]
        raise RuntimeError(f"LoungeKey login failed: {'; '.join(map(str, errors))}")

    dashboard = session.get(
        requests.compat.urljoin(LOGIN_URL, login_result["RedirectUrl"]), timeout=timeout
    )
    dashboard.raise_for_status()
    page = dashboard.text
    qr_match = re.search(
        r'<img[^>]+class=["\'][^"\']*qr-code[^"\']*["\'][^>]+src=["\']data:image(?:/[^;]+)?;base64,([^"\']+)',
        page,
        flags=re.IGNORECASE,
    )
    if not qr_match:
        raise RuntimeError("LoungeKey QR image was not found on the dashboard")

    card = _dashboard_field(page, "Card Details")
    expiration = datetime.strptime(
        _dashboard_field(page, "Card Expiration Date"), "%d %b %Y"
    ).strftime("%Y-%m-%d")
    date_added = datetime.strptime(
        _dashboard_field(page, "Date Card Added"), "%d %b %Y"
    ).strftime("%Y-%m-%d")
    return {
        "name": _dashboard_field(page, "Name on card"),
        "lounge_number": _dashboard_field(page, "Lounge Access Number"),
        "card_last4": card[-4:],
        "expiration": expiration,
        "date_added": date_added,
        "qr_message": decode_qr_image(base64.b64decode(qr_match.group(1))),
    }


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
    serial_number: str | None = None,
    web_service_url: str | None = None,
    authentication_token: str | None = None,
) -> dict:
    card_on_file = mask_card(card_last4)
    card_header = short_card(card_last4)
    expiration = format_date(expiration_date)
    added = format_date(date_added)

    pass_json = {
        "description": "LoungeKey Membership",
        "formatVersion": 1,
        "organizationName": "LoungeKey",
        "passTypeIdentifier": "pass.com.loungekey.membership",
        "serialNumber": serial_number or lounge_number,
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
    if web_service_url:
        if not authentication_token:
            raise ValueError("authentication_token is required with web_service_url")
        pass_json["webServiceURL"] = web_service_url.rstrip("/")
        pass_json["authenticationToken"] = authentication_token
    return pass_json


def encode_password_token(password: str) -> str:
    """Encode a password for the pass authenticationToken (encoding, not encryption)."""
    return base64.urlsafe_b64encode(password.encode("utf-8")).decode("ascii").rstrip("=")


def decode_password_token(token: str) -> str:
    padding = "=" * (-len(token) % 4)
    try:
        return base64.b64decode(token + padding, altchars=b"-_", validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("invalid password token") from exc


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
            for name in os.listdir(assets_dir):
                source = os.path.join(assets_dir, name)
                if os.path.isfile(source):
                    shutil.copy(source, os.path.join(tmp, name))
        else:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            create_assets(tmp, script_dir=script_dir)

        manifest = make_manifest(tmp)
        with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in os.listdir(tmp):
                path = os.path.join(tmp, name)
                if os.path.isfile(path):
                    zf.write(path, name)


# ===== CLI =====
def main():
    parser = argparse.ArgumentParser(description="Generate unsigned LoungeKey pkpass")
    parser.add_argument("--env-file", default="account1.env", help="LoungeKey credentials file")
    parser.add_argument("--manual", action="store_true", help="Do not fetch data from LoungeKey")
    parser.add_argument("--name", help="Имя владельца")
    parser.add_argument("--lounge-number", help="Lounge Access Number")
    parser.add_argument("--card-last4", help="Последние 4 цифры карты (XXXX)")
    parser.add_argument("--expiration", help="Срок действия карты, YYYY-MM-DD")
    parser.add_argument("--date-added", help="Дата добавления карты, YYYY-MM-DD")
    parser.add_argument("--qr-message", help="Текст, закодированный в QR")
    parser.add_argument("--assets", help="Папка с icon.png, logo.png, strip.png")
    parser.add_argument(
        "--web-service-url",
        help="Base URL of the stateless pass refresh server",
    )
    parser.add_argument("-o", "--output", required=True, help="Путь к .pkpass")
    args = parser.parse_args()

    if args.manual:
        if args.web_service_url:
            parser.error("--web-service-url requires automatic mode with LoungeKey credentials")
        data = {key: getattr(args, key) for key in (
            "name", "lounge_number", "card_last4", "expiration", "date_added", "qr_message"
        )}
        missing = [key.replace("_", "-") for key, value in data.items() if not value]
        if missing:
            parser.error("--manual requires: " + ", ".join(f"--{key}" for key in missing))
    else:
        try:
            credentials = load_env(args.env_file)
            username = credentials["LOUNGEKEY_LOGIN"]
            password = credentials["LOUNGEKEY_PASSWORD"]
        except (OSError, KeyError) as exc:
            parser.error(f"could not load LOUNGEKEY_LOGIN/LOUNGEKEY_PASSWORD: {exc}")
        data = fetch_loungekey_data(username, password)

        # Explicit values remain useful as emergency per-field overrides.
        for key in data:
            override = getattr(args, key)
            if override is not None:
                data[key] = override

    pass_json = make_pass_json(
        name=data["name"],
        lounge_number=data["lounge_number"],
        card_last4=data["card_last4"],
        expiration_date=data["expiration"],
        date_added=data["date_added"],
        qr_message=data["qr_message"],
        serial_number=username if not args.manual and args.web_service_url else None,
        web_service_url=args.web_service_url,
        authentication_token=(
            encode_password_token(password) if not args.manual and args.web_service_url else None
        ),
    )
    build_pkpass(pass_json, args.output, args.assets)
    print(f"Created: {args.output}")


if __name__ == "__main__":
    main()
