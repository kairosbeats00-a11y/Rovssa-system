# Llevar ROVSSA al rover

## Antes de salir

Llevá release/ROVSSA-listo.zip y una PC con Python 3.9.2 o posterior. La primera instalación requiere Internet en la Jetson para descargar paquetes. El rover debe tener SSH habilitado, usuario con sudo y dirección IP conocida. Reservá esa IP en el router.

Extraé el ZIP en la PC. Desde su carpeta ROVSSA ejecutá:

~~~powershell
python -m pip install -r requirements-test.txt
python deploy/prepare.py 192.168.1.100
~~~

Reemplazá la IP por la real. Se crea .security-pc con una CA privada local y una carpeta jetson. Conservá la CA privada en esta PC. Importá únicamente ca-public.pem en el almacén de autoridades raíz de confianza del usuario de Windows, mediante el asistente de certificados.

Copiá el ZIP a la Jetson mediante SCP o pendrive y extraelo. Copiá SOLO el contenido de .security-pc/jetson dentro de una carpeta .security en la raíz ROVSSA de la Jetson. Conservá la configuración del rover para futuras actualizaciones.

## Instalar una vez en la Jetson

Desde la carpeta ROVSSA:

~~~sh
sudo sh deploy/install.sh
~~~

El instalador comprueba Python antes de modificar el sistema, instala los paquetes base, copia el servidor y la consola, pide una contraseña para el usuario operador y habilita el arranque automático.

Si tu JetPack trae un Python anterior, el instalador se detiene. Hace falta preparar un Python compatible con las bibliotecas del hardware antes de continuar. Un Python alternativo ya instalado se selecciona mediante:

~~~sh
sudo env ROVSSA_PYTHON=/ruta/al/python3 deploy/install.sh
~~~

Si el script no tiene permiso de ejecución, usar sudo env ROVSSA_PYTHON=/ruta/al/python3 sh deploy/install.sh.

La primera instalación inicia en simulación. Las bibliotecas GPIO, los plugins NVIDIA de GStreamer y las bibliotecas de la IMU dependen del JetPack instalado. Para BNO085 el entorno /srv/rovssa/venv debe poder importar board, busio y adafruit_bno08x. Validar estas bibliotecas en la Jetson real.

## Verificar desde la PC

Conectá la PC al router y abrí https://192.168.1.100. Usá operador y la contraseña elegida al instalar. También podés ejecutar:

~~~powershell
python deploy/verify_station.py https://192.168.1.100 --ca .security-pc/ca-public.pem
~~~

Pide la contraseña sin mostrarla. Comprueba HTTPS, autenticación, estado del servidor y cada sensor. Luego crea un evento de prueba, lo descarga y verifica la firma. El evento queda en el historial. Un sensor sin lectura se informa por separado.

Para pasar a hardware, editá /etc/rovssa/backend.env en la Jetson y cambiá ROVSSA_SIMULATION=1 por ROVSSA_SIMULATION=0. Configurá ROVSSA_GPS_PORT y ROVSSA_USB_INDEX si hace falta. Reiniciá:

~~~sh
sudo systemctl restart rovssa
~~~

Repetí la verificación, comprobá ambas imágenes en la consola y mové la IMU. Probá GPS al aire libre. Finalmente apagá y encendé la Jetson y comprobá que podés entrar desde la PC sin iniciar el servidor a mano.

## Uso diario

Encendé el router y la Jetson, conectá la PC a su Wi-Fi y abrí Abrir ROVSSA.html. Ingresá la dirección configurada y entrá con la cuenta operador. Para publicar registros en Fuji, abrí ROVSSA en el navegador que tiene instalada tu wallet.

## Si falla el arranque

En la Jetson, systemctl status rovssa nginx muestra los servicios y journalctl -u rovssa -b muestra los errores del servidor. Los certificados vencen a los 180 días y necesitan renovación. Una IP distinta necesita un certificado que incluya esa dirección.

Esta entrega fue preparada y probada desde Windows. La instalación completa, los plugins NVIDIA y los sensores requieren validación sobre la Jetson real.

