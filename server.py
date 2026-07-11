#!/usr/bin/env python3
"""Stateless Android pkpass refresh server for LoungeKey."""

import argparse
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from generate import (
    build_pkpass,
    decode_password_token,
    encode_password_token,
    fetch_loungekey_data,
    make_pass_json,
)


PASS_TYPE_IDENTIFIER = "pass.com.loungekey.membership"
REFRESH_PATH = re.compile(r"^/v1/passes/([^/]+)/([^/]+)$")


class PassRequestHandler(BaseHTTPRequestHandler):
    server_version = "LoungeKeyPassServer/1.0"

    def _json_error(self, status: int, message: str) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _public_base_url(self) -> str:
        configured = os.environ.get("PASS_SERVER_URL")
        if configured:
            return configured.rstrip("/")
        scheme = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip()
        host = self.headers.get("X-Forwarded-Host", self.headers.get("Host", "localhost"))
        return f"{scheme}://{host}".rstrip("/")

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/healthz":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        match = REFRESH_PATH.fullmatch(path)
        if not match:
            self._json_error(404, "not found")
            return
        pass_type = unquote(match.group(1))
        username = unquote(match.group(2))
        if pass_type != PASS_TYPE_IDENTIFIER:
            self._json_error(404, "unknown pass type")
            return
        if not username or len(username) > 256:
            self._json_error(400, "invalid username")
            return

        authorization = self.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if not separator or scheme.lower() != "applepass" or not token:
            self._json_error(401, "missing ApplePass authorization")
            return
        try:
            password = decode_password_token(token)
            account = fetch_loungekey_data(username, password)
            pass_json = make_pass_json(
                name=account["name"],
                lounge_number=account["lounge_number"],
                card_last4=account["card_last4"],
                expiration_date=account["expiration"],
                date_added=account["date_added"],
                qr_message=account["qr_message"],
                serial_number=username,
                web_service_url=self._public_base_url(),
                authentication_token=encode_password_token(password),
            )
            with tempfile.NamedTemporaryFile(suffix=".pkpass") as output:
                build_pkpass(pass_json, output.name)
                output.seek(0)
                body = output.read()
        except ValueError:
            self._json_error(401, "invalid ApplePass authorization")
            return
        except Exception as exc:
            self.log_error("refresh failed for %r: %s", username, exc)
            self._json_error(502, "could not refresh pass from LoungeKey")
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.pkpass")
        self.send_header("Content-Disposition", 'attachment; filename="loungekey.pkpass"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stateless LoungeKey pass refresh server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), PassRequestHandler)
    print(f"Listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
