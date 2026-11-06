"""Generate LOCAL deployment secrets/config. Never commits or installs them."""
import argparse
import os
from pathlib import Path
import re
import secrets


def generate(hostname, cert, key, webroot, output):
    if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?', hostname):
        raise ValueError('Invalid DNS hostname')
    for value in (cert, key, webroot):
        if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', value):
            raise ValueError('Use absolute Linux paths without spaces or configuration syntax')
    output=Path(output)
    if output.exists():
        raise ValueError('Output already exists; refusing to overwrite deployment credentials')
    output.mkdir(mode=0o700,parents=True)
    secret=secrets.token_hex(32)
    config=Path(__file__).with_name('nginx.conf.template').read_text(encoding='utf-8')
    for label,value in [('HOST',hostname),('CERT',cert),('KEY',key),('WEBROOT',webroot),('SECRET',secret)]:
        config=config.replace('__'+label+'__',value)
    for name,content in [('nginx.conf',config),('backend.env',f'ROVSSA_PROXY_SECRET={secret}\nROVSSA_ORIGIN=https://{hostname}\nROVSSA_SIMULATION=1\n')]:
        path=output/name
        fd=os.open(str(path), os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:f.write(content)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--hostname',required=True)
    p.add_argument('--cert',required=True)
    p.add_argument('--key',required=True)
    p.add_argument('--webroot',default='/srv/rovssa/dist')
    p.add_argument('--output',default='.security')
    a=p.parse_args();generate(a.hostname,a.cert,a.key,a.webroot,a.output)
    print('Local configuration generated in simulation mode. See SECURITY.md for installation.')
