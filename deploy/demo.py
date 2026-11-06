"""Local rehearsal with the actual simulator, built UI and no hardware access."""
import os
import secrets
import sys
from pathlib import Path

from flask import Flask, send_from_directory
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('ROVSSA_DEMO_PORT', '8765'))
HOST = f'127.0.0.1:{PORT}' 


def main():
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
        # Loopback only, including Host and write origin (DNS rebinding/CSRF).
        if (environ.get('HTTP_HOST') != HOST or environ.get('REMOTE_ADDR') != '127.0.0.1'
                or (environ.get('REQUEST_METHOD') == 'POST'
                    and environ.get('HTTP_ORIGIN') != 'http://' + HOST)):
            start_response('403 Forbidden', [('Content-Type', 'text/plain')])
            return [b'Local demo only']
        environ.update(HTTP_X_ROVSSA_PROXY=secret, HTTP_X_FORWARDED_PROTO='https',
                       HTTP_ORIGIN='https://demo.invalid')
        return dispatch(environ, start_response)

    print('Simulación local: http://' + HOST, flush=True)
    run_simple('127.0.0.1', PORT, local_demo, threaded=True)


if __name__ == '__main__':
    main()

