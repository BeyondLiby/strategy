import base64
import ctypes
import json
import os
import sqlite3
import sys
from ctypes import wintypes
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


EDGE_USER_DATA = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Edge" / "User Data"
LOCAL_STATE = EDGE_USER_DATA / "Local State"
COOKIES_DB = Path(os.environ.get("EDGE_COOKIES_DB", EDGE_USER_DATA / "Default" / "Network" / "Cookies"))
OUTPUT = Path(__file__).resolve().parents[1] / "runtime" / "auth.json"
DOMAIN_NEEDLE = "rabyte.cn"
WINDOWS_EPOCH_OFFSET = 11644473600


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def crypt_unprotect_data(encrypted: bytes) -> bytes:
    blob_in = DATA_BLOB(len(encrypted), ctypes.cast(ctypes.create_string_buffer(encrypted), ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        raise ctypes.WinError()

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def load_edge_key() -> bytes:
    local_state = json.loads(LOCAL_STATE.read_text(encoding="utf-8"))
    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    if encrypted_key.startswith(b"DPAPI"):
        encrypted_key = encrypted_key[5:]
    return crypt_unprotect_data(encrypted_key)


def decrypt_cookie(encrypted_value: bytes, key: bytes) -> str:
    if not encrypted_value:
        return ""

    if encrypted_value.startswith((b"v10", b"v11")):
        nonce = encrypted_value[3:15]
        ciphertext_and_tag = encrypted_value[15:]
        return AESGCM(key).decrypt(nonce, ciphertext_and_tag, None).decode("utf-8")

    if encrypted_value.startswith(b"v20"):
        raise RuntimeError("Edge cookie uses v20 app-bound encryption, which this exporter cannot decrypt.")

    return crypt_unprotect_data(encrypted_value).decode("utf-8")


def chromium_expires_to_unix(value: int) -> int:
    if not value:
        return -1
    return int(value / 1_000_000 - WINDOWS_EPOCH_OFFSET)


def same_site(value: int) -> str:
    return {
        1: "Lax",
        2: "Strict",
        3: "None",
    }.get(value, "Lax")


def main() -> int:
    if not LOCAL_STATE.exists() or not COOKIES_DB.exists():
        print("Edge profile cookie files were not found.", file=sys.stderr)
        return 1

    key = load_edge_key()
    db_uri = COOKIES_DB.as_posix().replace("'", "''")
    connection = sqlite3.connect(f"file:{db_uri}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value
        FROM cookies
        WHERE host_key LIKE ?
        ORDER BY host_key, name
        """,
        (f"%{DOMAIN_NEEDLE}%",),
    ).fetchall()
    connection.close()

    cookies = []
    failures = []
    for row in rows:
        try:
            value = decrypt_cookie(row["encrypted_value"], key)
        except Exception as error:
            failures.append((row["host_key"], row["name"], str(error)))
            continue

        cookies.append(
            {
                "name": row["name"],
                "value": value,
                "domain": row["host_key"],
                "path": row["path"] or "/",
                "expires": chromium_expires_to_unix(row["expires_utc"]),
                "httpOnly": bool(row["is_httponly"]),
                "secure": bool(row["is_secure"]),
                "sameSite": same_site(row["samesite"]),
            }
        )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"cookies": cookies, "origins": []}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(cookies)} cookies for {DOMAIN_NEEDLE} to {OUTPUT}")
    if failures:
        print(f"Skipped {len(failures)} cookies that could not be decrypted.", file=sys.stderr)
        for host, name, message in failures[:5]:
            print(f"- {host} {name}: {message}", file=sys.stderr)
    return 0 if cookies else 2


if __name__ == "__main__":
    raise SystemExit(main())
