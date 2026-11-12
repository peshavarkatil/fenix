"""Paths, network binding and key discovery.

The Garmin Personal API key never leaves this process: it is read from your
environment or key file, exchanged for a short-lived bearer token by Garmin's
own client, and never sent to the browser.
"""
from __future__ import annotations


def has_api_key() -> bool:
    """True when a Personal API key can be found. Never returns the key."""
    from garmin_personal_api import resolve_api_key

    try:
        return bool(resolve_api_key())
    except Exception:
        return False
