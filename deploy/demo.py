"""Local rehearsal with the actual simulator, built UI and no hardware access."""
import argparse
import hmac
import ipaddress
import os
import secrets
import sys
from pathlib import Path

from flask import Flask, send_from_directory
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple
from werkzeug.datastructures import Authorization

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('ROVSSA_DEMO_PORT', '8765'))
HOST = f'127.0.0.1:{PORT}' 


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lan-ip', help='IPv4 local de esta PC para la prueba HTTPS en celular')
    parser.add_argument('--cert', type=Path)
    parser.add_argument('--key', type=Path)
    parser.add_argument('--password-file', type=Path, help='Archivo privado con la contraseña del usuario operador')
    args = parser.parse_args()
    bind = '127.0.0.1'
    host = HOST
    origin = 'http://' + host
    password = None
    tls = None
    if args.lan_ip:
        address = ipaddress.IPv4Address(args.lan_ip)
        if not address.is_private or address.is_unspecified or address.is_loopback or address.is_link_local:
            parser.error('Usar la IP privada de la interfaz de red local.')
        if not all((args.cert, args.key, args.password_file)):
            parser.error('El modo LAN requiere --cert, --key y --password-file.')
        password = args.password_file.read_text(encoding='utf-8').strip()
        if len(password) < 12:
            parser.error('La contraseña de prueba debe tener al menos 12 caracteres.')
        bind = str(address)
        host = f'{bind}:{PORT}'
        origin = 'https://' + host
        tls = (str(args.cert), str(args.key))
    elif any((args.cert, args.key, args.password_file)):
        parser.error('Las opciones TLS se usan con --lan-ip.')
    if not (ROOT / 'dist/index.html').exists():
        sys.exit('Primero ejecutá npm ci y npm run build en la raíz del proyecto.')
    os.environ.setdefault("ROVSSA_EVENT_DIR", str(ROOT / ".rovssa-demo"))
    secret = secrets.token_hex(32)
    os.environ.update(ROVSSA_SIMULATION='1', ROVSSA_PROXY_SECRET=secret,
                      ROVSSA_ORIGIN='https://demo.invalid')
    sys.path.insert(0, str(ROOT / 'entorno de simulacion'))
    from jetson_server import app as simulator

    static = Flask('demo', static_folder=None)

    @static.get('/')
    @static.get('/<path:name>')
    def assets(name='index.html'):
        return send_from_directory(ROOT / 'dist', name)

    dispatch = DispatcherMiddleware(static, {'/api': simulator})

    def local_demo(environ, start_response):
        # Explicit host/origin checks also protect the opt-in LAN simulator.
        if (environ.get('HTTP_HOST') != host
                or (not args.lan_ip and environ.get('REMOTE_ADDR') != '127.0.0.1')
                or (args.lan_ip and environ.get('wsgi.url_scheme') != 'https')
                or (environ.get('REQUEST_METHOD') == 'POST'
                    and environ.get('HTTP_ORIGIN') != origin)):
            start_response('403 Forbidden', [('Content-Type', 'text/plain')])
            return [b'Origin not allowed']
        if password is not None:
            auth = Authorization.from_header(environ.get('HTTP_AUTHORIZATION', ''))
            if (not auth or auth.type != 'basic' or auth.username != 'operador'
                    or not hmac.compare_digest((auth.password or '').encode(), password.encode())):
                start_response('401 Unauthorized', [
                    ('WWW-Authenticate', 'Basic realm="ROVSSA simulacion", charset="UTF-8"'),
                    ('Content-Type', 'text/plain'), ('Cache-Control', 'no-store')])
                return [b'Operator login required']
        # The simulator's proxy gate expects a trusted loopback proxy.
        environ.update(HTTP_X_ROVSSA_PROXY=secret, HTTP_X_FORWARDED_PROTO='https',
                       HTTP_ORIGIN='https://demo.invalid', REMOTE_ADDR='127.0.0.1')
        return dispatch(environ, start_response)

    print('Simulación: ' + origin, flush=True)
    run_simple(bind, PORT, local_demo, threaded=True, ssl_context=tls)


if __name__ == '__main__':
    main()

