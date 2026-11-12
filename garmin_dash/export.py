"""Encrypt / decrypt the published data file.

The file is public (GitHub Pages), so it is encrypted: AES-256-GCM with a key
derived from your passphrase (PBKDF2-SHA256, 600,000 rounds). Without the
passphrase it is random noise. The browser decrypts it with the same recipe.

File layout:  b"FDX1" | salt (16) | nonce (12) | ciphertext + 16-byte tag
The header (magic + salt) is authenticated, so tampering with it is detected.
"""
from __future__ import annotations

import hashlib
import os
import unicodedata

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"FDX1"
ITER = 600_000
SALT_LEN, NONCE_LEN = 16, 12
MIN_PASSPHRASE = 12


class WrongPassphrase(Exception):
    """Wrong passphrase, or the file is damaged."""


def clean(passphrase: str) -> str:
    # Same normalisation as the browser: phones love to add trailing spaces.
    return unicodedata.normalize("NFKC", passphrase).strip()


def derive(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", clean(passphrase).encode("utf-8"), salt, ITER, dklen=32)


def encrypt(payload: bytes, passphrase: str, salt: bytes | None = None, nonce: bytes | None = None) -> bytes:
    if len(clean(passphrase)) < MIN_PASSPHRASE:
        raise ValueError(f"passphrase must be at least {MIN_PASSPHRASE} characters")
    salt = salt or os.urandom(SALT_LEN)
    nonce = nonce or os.urandom(NONCE_LEN)
    header = MAGIC + salt
    ct = AESGCM(derive(passphrase, salt)).encrypt(nonce, payload, header)
    return header + nonce + ct


def header_salt(blob: bytes) -> bytes:
    if blob[:4] != MAGIC:
        raise WrongPassphrase("not a Fenix data file")
    return blob[4:4 + SALT_LEN]


def decrypt(blob: bytes, passphrase: str) -> bytes:
    if len(blob) < 4 + SALT_LEN + NONCE_LEN + 16 or blob[:4] != MAGIC:
        raise WrongPassphrase("not a Fenix data file")
    header = blob[:4 + SALT_LEN]
    nonce = blob[4 + SALT_LEN:4 + SALT_LEN + NONCE_LEN]
    ct = blob[4 + SALT_LEN + NONCE_LEN:]
    try:
        return AESGCM(derive(passphrase, header[4:])).decrypt(nonce, ct, header)
    except InvalidTag as e:
        raise WrongPassphrase("wrong passphrase or damaged file") from e
