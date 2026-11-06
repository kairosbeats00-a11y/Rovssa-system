#!/bin/sh
# Run on the Jetson after generating .security and building dist on the PC.
set -eu
cd "$(dirname "$0")/.."
if [ "$(id -u)" != 0 ]; then echo "Ejecutar con sudo."; exit 1; fi
python_bin=${ROVSSA_PYTHON:-python3}
"$python_bin" -c 'import sys; assert sys.version_info >= (3,9,2), "Se requiere Python 3.9.2+. Seleccionar un Python compatible con ROVSSA_PYTHON."'
test -d /run/systemd/system || { echo "Se requiere Linux con systemd."; exit 1; }
command -v apt-get >/dev/null
for file in .security/backend.env .security/nginx.conf dist/index.html; do
  test -s "$file" || { echo "Falta $file"; exit 1; }
done
apt-get update
apt-get install -y nginx apache2-utils python3-venv python3-pip gstreamer1.0-tools gstreamer1.0-plugins-good
"$python_bin" -m venv --help >/dev/null
install -d -m 0750 -o root -g www-data /etc/rovssa
for file in server-chain.pem server-key.pem; do
  if [ ! -s "/etc/rovssa/$file" ]; then
    test -s ".security/$file" || { echo "Falta certificado .security/$file"; exit 1; }
    install -m 0600 ".security/$file" "/etc/rovssa/$file"
  fi
done
getent passwd rovssa >/dev/null || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin rovssa
for group in video dialout gpio i2c; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" rovssa; fi
done
install -d /srv/rovssa/backend /srv/rovssa/dist
install -d -m 0750 -o root -g www-data /etc/rovssa
install -m 0644 'entorno de simulacion/'*.py /srv/rovssa/backend/
cp -R dist/. /srv/rovssa/dist/
if [ ! -x /srv/rovssa/venv/bin/python ]; then "$python_bin" -m venv --system-site-packages /srv/rovssa/venv; fi
/srv/rovssa/venv/bin/python -m pip install 'Flask==3.1.3' 'pyserial==3.5' pynmea2 'cryptography==50.0.2'
if [ ! -f /etc/rovssa/operators.htpasswd ]; then htpasswd -cB /etc/rovssa/operators.htpasswd operador; fi
chown root:www-data /etc/rovssa/operators.htpasswd
chmod 0640 /etc/rovssa/operators.htpasswd
# Preserve operator-selected hardware mode and keep the proxy secret paired.
if [ -f /etc/rovssa/backend.env ]; then
  for var in ROVSSA_PROXY_SECRET ROVSSA_ORIGIN; do
    test "$(grep "^$var=" /etc/rovssa/backend.env)" = "$(grep "^$var=" .security/backend.env)" || { echo "La configuración existente difiere. Revisar antes de reemplazar."; exit 1; }
  done
else
  install -m 0600 .security/backend.env /etc/rovssa/backend.env
fi
install -m 0600 .security/nginx.conf /etc/nginx/sites-available/rovssa
ln -sfn /etc/nginx/sites-available/rovssa /etc/nginx/sites-enabled/rovssa
nginx -t
install -m 0644 deploy/rovssa.service /etc/systemd/system/rovssa.service
systemctl daemon-reload
systemctl enable --now nginx rovssa.service
systemctl restart rovssa.service
systemctl reload nginx
systemctl is-active rovssa.service nginx
