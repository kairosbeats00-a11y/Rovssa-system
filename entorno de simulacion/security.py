"""Trusted loopback proxy boundary. The TLS proxy authenticates every resource."""
import hmac
import os
from urllib.parse import urlsplit
from flask import request, jsonify


def install_security(app):
    secret = os.environ.get("ROVSSA_PROXY_SECRET", "")
    origin = os.environ.get("ROVSSA_ORIGIN", "")
    parsed = urlsplit(origin)
    if len(secret) < 32 or any(c not in "0123456789abcdef" for c in secret):
        raise RuntimeError("ROVSSA_PROXY_SECRET must contain at least 32 random hex characters")
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise RuntimeError("ROVSSA_ORIGIN must be an exact HTTPS origin, without a path")
    app.config.update(MAX_CONTENT_LENGTH=16384)

    @app.before_request
    def authenticate():
        supplied = request.headers.get("X-ROVSSA-Proxy", "")
        if request.remote_addr not in ("127.0.0.1", "::1") or not hmac.compare_digest(supplied.encode("utf-8"), secret.encode("ascii")):
            return jsonify(error="Authentication required"), 401
        if request.headers.get("X-Forwarded-Proto") != "https":
            return jsonify(error="HTTPS required"), 403
        if request.method not in ("GET", "HEAD"):
            # Basic auth credentials may be sent automatically by a browser.
            # Require exact Origin and a non-simple custom header to stop CSRF.
            if request.headers.get("Origin") != origin or request.headers.get("X-ROVSSA-Request") != "1":
                return jsonify(error="Invalid request origin"), 403
            if not request.is_json:
                return jsonify(error="application/json required"), 415

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
