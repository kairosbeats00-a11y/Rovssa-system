"""Verify the installed station through HTTPS from the operator PC."""
import argparse
import base64
import getpass
import hashlib
import json
import ssl
import urllib.request
import uuid
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from verify_tls import verify

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin')
    parser.add_argument('--ca',required=True)
    parser.add_argument('--user',default='operador')
    args=parser.parse_args()
    origin=args.origin.rstrip('/')
    verify(origin+'/',args.ca)
    password=getpass.getpass('Contraseña de operador: ')
    authorization=base64.b64encode((args.user+':'+password).encode()).decode()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):
            return None
    opener=urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=args.ca)),NoRedirect())
    def request(path,body=None):
        data=None if body is None else json.dumps(body).encode()
        headers={'Authorization':'Basic '+authorization,'Origin':origin,
                 'X-ROVSSA-Request':'1','Content-Type':'application/json'}
        with opener.open(urllib.request.Request(origin+'/api'+path,data=data,headers=headers),timeout=20) as response:
            return response.read()
    status=json.loads(request('/status'))
    print('Servidor accesible. Simulación:',status['simulation'])
    report=json.loads(request('/diagnostics'))
    for name,available in report['signals'].items():
        print(name, 'lectura vigente' if available else 'sin lectura vigente')
    public=json.loads(request('/identity'))['public_key']
    meta=json.loads(request('/events',{'id':str(uuid.uuid4())}))
    content=request('/events/'+meta['id'])
    assert '0x'+hashlib.sha256(content).hexdigest()==meta['digest'], 'Copia alterada'
    record=json.loads(content)
    signature=record['signature']
    key=ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(),bytes.fromhex(public[2:]))
    key.verify(utils.encode_dss_signature(int(signature[:64],16),int(signature[64:],16)),
               record['payload'].encode(),ec.ECDSA(hashes.SHA256()))
    print('OK: evento guardado, recuperado y firma válida con la identidad de este servidor HTTPS.')
    print('El evento de verificación queda en el historial.')

if __name__=='__main__':
    main()

