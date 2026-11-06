"""Dedicated capture identity, independent of the operator wallet."""
import json
import os
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def private_key():
    directory = Path(os.environ.get("ROVSSA_EVENT_DIR", "/var/lib/rovssa"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / "capture-key.pem"
    if not path.exists():
        key = ec.generate_private_key(ec.SECP256K1())
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as tmp:
            try:
                tmp.write(key.private_bytes(serialization.Encoding.PEM,
                          serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp.close()
                try:
                    os.link(tmp.name, path)  # Exclusive publication, including concurrent first use.
                except FileExistsError:
                    pass
            finally:
                tmp.close()
                os.unlink(tmp.name)
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256K1):
        raise ValueError("Identidad de captura incompatible")
    return key


def public_key():
    return "0x" + private_key().public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint).hex()


def seal(event):
    payload = json.dumps(event, allow_nan=False, sort_keys=True, separators=(',', ':'))
    der = private_key().sign(payload.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    return json.dumps({"schema":"rovssa.signed.v1", "payload":payload,
                       "signature":f"{r:064x}{min(s, ORDER-s):064x}"},
                      separators=(',', ':')).encode()

