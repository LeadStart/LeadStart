#!/usr/bin/env python3
"""Self-hosted anti-bot fetch helper — TLS/HTTP-2 fingerprint impersonation.

Ported from the saasassins anti-bot engine (144/144 recovery on a hard set).
Replaces a paid unblocker for sites that gate on their TLS/JA3 + HTTP-2 (Akamai)
fingerprint rather than a JS challenge: curl_cffi reproduces a real Chrome
fingerprint, so a plain fetch sails through and the content is already in the
static HTML — no browser/JS render needed.

Invoked from src/fingerprintFetch.ts via child_process. Prints a SINGLE JSON
line to stdout so the Node side can JSON.parse it:
    {"status": <int>, "html": <str|null>, "error": <str|null>}

Modes:
    fingerprint_fetch.py --check                     -> {"ok": true} if curl_cffi imports
    fingerprint_fetch.py <url> [impersonate] [proxy] -> fetch <url>
      impersonate defaults to "chrome"; proxy (optional) is an http(s) proxy URL
      for the residential-IP tier ("" or "-" means none).
"""
import json
import sys


def emit(obj) -> None:
    # ensure_ascii=True keeps the whole payload on one physical line (newlines
    # in the HTML are escaped to \n), so the Node side reads exactly one line.
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> None:
    args = sys.argv[1:]
    if not args:
        emit({"status": 0, "html": None, "error": "no url argument"})
        return

    try:
        from curl_cffi import requests
    except Exception as e:  # curl_cffi not installed in this interpreter
        emit({"status": 0, "html": None, "error": f"curl_cffi import failed: {e}"})
        return

    if args[0] == "--check":
        emit({"ok": True})
        return

    url = args[0]
    impersonate = args[1] if len(args) > 1 else "chrome"
    proxy = args[2] if len(args) > 2 else ""
    proxies = None
    if proxy and proxy not in ("-", ""):
        proxies = {"http": proxy, "https": proxy}

    try:
        r = requests.get(
            url,
            impersonate=impersonate,
            timeout=25,
            allow_redirects=True,
            proxies=proxies,
        )
        emit({"status": r.status_code, "html": r.text, "error": None})
    except Exception as e:
        emit({"status": 0, "html": None, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
