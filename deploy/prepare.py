"""Run on the PC. Keep the CA private key on this PC."""
import argparse
import ipaddress
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from configure import generate

def prepare(host, directory):
    try:
        san = x509.IPAddress(ipaddress.ip_address(host))
    except ValueError:
        san = x509.DNSName(host.encode('idna').decode())
    root = Path(directory)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ROVSSA local ' + secrets.token_hex(4))])
    ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=365))
          .add_extension(x509.BasicConstraints(ca=True,path_length=0),True)
          .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,None,None),True)
          .sign(ca_key,hashes.SHA256()))
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,host)]))
            .issuer_name(name).public_key(server_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=180))
            .add_extension(x509.BasicConstraints(ca=False,path_length=None),True)
            .add_extension(x509.SubjectAlternativeName([san]),False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),False)
            .sign(ca_key,hashes.SHA256()))
    def private(key):
        return key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
    (root/'ca-private.key').write_bytes(private(ca_key))
    (root/'ca-public.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    target=root/'jetson'
    generate(host,'/etc/rovssa/server-chain.pem','/etc/rovssa/server-key.pem','/srv/rovssa/dist',target)
    (target/'server-chain.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM)+ca.public_bytes(serialization.Encoding.PEM))
    (target/'server-key.pem').write_bytes(private(server_key))
    print('Copiar SOLO la carpeta jetson a .security en el paquete del rover.')
    print('Importar ca-public.pem como CA confiable en la PC. Conservar ca-private.key en esta PC.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    parser.add_argument('--output',default='.security-pc')
    args=parser.parse_args()
    prepare(args.host,args.output)

