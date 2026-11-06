import datetime
import importlib.util
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
import urllib.error
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
spec=importlib.util.spec_from_file_location('verify_tls',DEPLOY/'verify_tls.py')
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
spec=importlib.util.spec_from_file_location('configure',DEPLOY/'configure.py')
configure=importlib.util.module_from_spec(spec);spec.loader.exec_module(configure)


class TLSTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        now=datetime.datetime.now(datetime.timezone.utc)
        cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name)
              .public_key(key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now-datetime.timedelta(minutes=1))
              .not_valid_after(now+datetime.timedelta(days=1))
              .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False)
              .sign(key,hashes.SHA256()))
        self.cert=self.root/'cert.pem';self.key=self.root/'key.pem'
        self.cert.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        self.key.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401);self.send_header('WWW-Authenticate','Basic realm="test"');self.end_headers()
            def log_message(self,*args):pass
        self.server=HTTPServer(('127.0.0.1',0),Handler)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert,self.key)
        self.server.socket=context.wrap_socket(self.server.socket,server_side=True)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'https://localhost:{self.server.server_port}/'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()

    def test_trusted_certificate_and_auth_challenge(self):
        self.assertTrue(verifier.verify(self.url,str(self.cert)))

    def test_untrusted_certificate_rejected(self):
        with self.assertRaises(urllib.error.URLError) as error:verifier.verify(self.url)
        self.assertIsInstance(error.exception.reason, ssl.SSLCertVerificationError)

    def test_wrong_hostname_rejected(self):
        with self.assertRaises(urllib.error.URLError) as error:verifier.verify(self.url.replace('localhost','127.0.0.1'),str(self.cert))
        self.assertIsInstance(error.exception.reason, ssl.SSLCertVerificationError)

    def test_expired_certificate_rejected(self):
        key=serialization.load_pem_private_key(self.key.read_bytes(),password=None)
        old=x509.load_pem_x509_certificate(self.cert.read_bytes())
        now=datetime.datetime.now(datetime.timezone.utc)
        expired=(x509.CertificateBuilder().subject_name(old.subject).issuer_name(old.issuer)
                 .public_key(key.public_key()).serial_number(x509.random_serial_number())
                 .not_valid_before(now-datetime.timedelta(days=2))
                 .not_valid_after(now-datetime.timedelta(days=1))
                 .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False)
                 .sign(key,hashes.SHA256()))
        self.cert.write_bytes(expired.public_bytes(serialization.Encoding.PEM))
        self.server.socket.context.load_cert_chain(self.cert,self.key)
        with self.assertRaises(urllib.error.URLError) as error:verifier.verify(self.url,str(self.cert))
        self.assertIsInstance(error.exception.reason,ssl.SSLCertVerificationError)

    def test_cleartext_rejected(self):
        with self.assertRaises(ValueError):verifier.verify(self.url.replace('https:','http:'))


class ConfigurationTests(unittest.TestCase):
    def test_unique_secrets_and_protected_proxy(self):
        with tempfile.TemporaryDirectory() as temp:
            folders=[Path(temp)/name for name in ['one','two']]
            for folder in folders:
                configure.generate('rover.test','/etc/rovssa/cert.pem','/etc/rovssa/key.pem','/srv/rovssa/dist',folder)
            first=(folders[0]/'nginx.conf').read_text()
            self.assertIn('auth_basic_user_file',first)
            self.assertIn('ssl_protocols TLSv1.2 TLSv1.3;',first)
            self.assertIn('proxy_pass http://127.0.0.1:8000/',first)
            self.assertNotIn('__SECRET__',first)
            self.assertNotEqual((folders[0]/'backend.env').read_text(),(folders[1]/'backend.env').read_text())
            with self.assertRaises(ValueError):configure.generate('rover.test','/cert','/key','/dist',folders[0])

    def test_configuration_injection_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):configure.generate('rover; bad','/cert','/key','/dist',Path(temp)/'out')


if __name__=='__main__':unittest.main()
