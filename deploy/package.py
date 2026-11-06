"""Build a portable archive from an explicit allowlist, excluding keys and local records."""
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]

def package():
    if not (ROOT/'dist/index.html').exists():
        raise RuntimeError('Ejecutar npm run build primero')
    destination=ROOT/'release'
    destination.mkdir(exist_ok=True)
    files=list((ROOT/'dist').rglob('*'))
    files+=list((ROOT/'entorno de simulacion').glob('*.py'))
    files+=list((ROOT/'deploy').glob('*.py'))+list((ROOT/'deploy').glob('*.sh'))
    files += [ROOT/path for path in ['deploy/nginx.conf.template','deploy/rovssa.service',
              'requirements-test.txt','README.md','PUESTA-EN-MARCHA.md','SECURITY.md',
              'contracts/Observation.sol','Abrir ROVSSA.html']]
    with zipfile.ZipFile(destination/'ROVSSA-listo.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            if file.is_file():
                data=file.read_bytes()
                if file.suffix in ('.sh','.py','.service','.template'):
                    data=data.replace(b'\r\n',b'\n')
                archive.writestr('ROVSSA/'+file.relative_to(ROOT).as_posix(),data)
    print(destination/'ROVSSA-listo.zip')

if __name__=='__main__':
    package()

