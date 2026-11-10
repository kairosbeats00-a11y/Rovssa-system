# ROVSSA · Estación de control

Para instalar el proyecto en otra PC y arrancar la demo de escritorio o celular, seguí [Arrancar ROVSSA desde otra PC](ARRANQUE-DESDE-OTRA-PC.md).

## Uso diario

1. Encendé el router y la Jetson. Después de la instalación inicial, Linux inicia el servidor y nginx automáticamente.
2. Conectá la PC a la misma red. Hacé doble clic en **Abrir ROVSSA.html** en la PC, ingresá la IP o el nombre configurado en el certificado y conectá. También podés guardar esa dirección HTTPS en favoritos.
3. Iniciá sesión con la cuenta de operador. **En línea** significa que llegan mensajes de la Jetson. Cada cámara, el GPS, la IMU y el Pico tienen disponibilidad independiente. **Simulación** identifica una sesión sin hardware.

La PC solo necesita navegador para operar. La Jetson sirve tanto la consola React como la API Flask. nginx cifra el tramo por el router y Flask escucha por HTTP únicamente dentro de la Jetson. Video viaja como MJPEG y telemetría como eventos SSE. La cámara USB del brazo funciona independientemente de sus servos. La teleoperación LeRobot, las misiones y la IA están desactivadas. El repositorio no contiene el firmware Arduino ni la VM original.

## Ensayo sin rover

En la PC con Node compatible con Vite 8 (22.12+ de la rama 22) y Python 3.9.2+:

~~~sh
npm ci
npm run build
python -m pip install -r requirements-test.txt
python deploy/demo.py
~~~

Abrí http://127.0.0.1:8765 en el navegador con tu wallet. **Registrar evento** genera un archivo marcado como simulación, sin foto ni lecturas inventadas. Sirve para ensayar descarga, emisión y verificación con el mismo código que la consola real. Solo escucha en la PC. Para detenerlo, Ctrl+C.

## Preparación inicial de la Jetson

### Visor de celular

El panel **VR (Experimental)** permite elegir la cámara frontal o del brazo y pulsar **Abrir visor**.
Solicita pantalla completa y orientación horizontal. Si el navegador restringe estas funciones,
ocupa la ventana y gira la presentación en vertical; puede ser necesario girar el teléfono y sus barras pueden seguir visibles.
El visor muestra una sola cámara para ambos ojos con corrección radial Brown/Cardboard mediante WebGL.
En **Ajustar a mi celular y casco** se configuran las medidas de pantalla/lentes y los coeficientes ópticos.
Los valores iniciales requieren calibración con el casco real. El patrón animado permite ajustar sin cámaras conectadas.
El contenido es monoscópico. La teleoperación por movimiento de cabeza queda pendiente.

El celular debe estar en la misma LAN, poder alcanzar la IP del servidor y confiar en su CA HTTPS.
En la Jetson usa la misma dirección HTTPS y cuenta de operador que la PC. Para probar desde una PC,
la demo permite HTTPS autenticado explícitamente, manteniendo el modo local por defecto:

~~~sh
python deploy/demo.py --lan-ip IP_DE_LA_PC --cert RUTA_CADENA_PEM --key RUTA_CLAVE_PEM --password-file RUTA_PASSWORD_TXT
~~~

El archivo de contraseña contiene la clave del usuario `operador` (mínimo 12 caracteres).
El puerto predeterminado es 8765 y se cambia con `ROVSSA_DEMO_PORT`.
Generá el certificado con `deploy/prepare.py` para la IP de la PC e instalá solamente su CA pública
en el celular. El firewall debe permitir ese puerto desde la red local. Conservá claves y contraseñas fuera del repositorio.

### Instalación

Se necesita una Jetson con systemd, nginx y Python 3.9.2+ que pueda usar las bibliotecas de su JetPack. Comprobá la versión antes de la competencia. Si la instalación usa un Python alternativo, indicá su ruta con ROVSSA_PYTHON al ejecutar el instalador. Usá una IP reservada por DHCP o un nombre local estable.

1. En la PC, ejecutá **npm ci** y **npm run build**. Copiá el repositorio y la carpeta **dist** recién compilada a la Jetson. Node no es necesario en el rover.
2. En la Jetson instalá nginx, apache2-utils, el módulo venv del Python elegido y GStreamer con nvarguscamerasrc, nvvidconv, jpegenc, v4l2src, jpegparse y fdsink. Conservá el soporte GPIO de JetPack. Para el BNO085, el Python del servicio necesita Blinka y adafruit-circuitpython-bno08x con acceso al bus I²C. Verificá que los dispositivos existen con los nombres esperados.
3. Prepará el certificado del servidor con SAN para la **misma IP o nombre** que vas a ingresar. Instalá la CA pública de confianza en la PC y colocá cadena y clave en las rutas siguientes, con la clave privada restringida a root. [Detalles de TLS y permisos](SECURITY.md).
4. Desde la raíz del repo en la Jetson, sustituí la IP de ejemplo por la real:

~~~sh
python3 deploy/configure.py --hostname 192.168.1.100 --cert /etc/rovssa/server-chain.pem --key /etc/rovssa/server-key.pem
sudo sh deploy/install.sh
~~~

El instalador usa la configuración generada, crea el usuario de servicio, pide la contraseña de operador y habilita el arranque automático. Requiere acceso a los paquetes Python durante la instalación. Conservá la carpeta privada .security para futuras actualizaciones. No la copies a la PC de operación. Para actualizar, copiá los archivos nuevos y repetí solo el instalador.

5. Abrí la consola en simulación. Con motores sin carga y el brazo sin alimentación, cambiá **ROVSSA_SIMULATION=0** en **/etc/rovssa/backend.env**. Si hace falta, agregá **ROVSSA_GPS_PORT** (por defecto /dev/ttyTHS1), **ROVSSA_USB_INDEX** (por defecto 1) y **ROVSSA_PICO_PORT** (por defecto se identifica por fabricante USB del Pico). Usá rutas /dev/serial/by-id cuando estén disponibles y asigná puertos distintos para GPS y Pico. Reiniciá el servicio una vez con **sudo systemctl restart rovssa**.
6. Apagá y encendé la Jetson y verificá el acceso desde la PC sin SSH. Para diagnóstico en instalación usá **systemctl status rovssa nginx** y **journalctl -u rovssa -b**. Probá CSI y USB individualmente, mové la IMU y verificá posición GPS al aire libre. Revisá el archivo de una captura y comparalo con la vista. El GPS figura como ausente cuando pierde el fix. La conducción actual es por radiocontrol. La consola y el servicio del rover solo leen del Pico.

## Registrar un evento de exploración

Manejá con el radiocontrol y mirá ambas cámaras, el mapa y los valores numéricos. Cuando veas algo de interés pulsá **Registrar evento**. La Jetson guarda un JSON con identificador, hora UTC, origen del disparo, imágenes CSI y USB (JPEG en base64, con sus horas de recepción), GPS, orientación, tres distancias, encoders, odometría y canales de radio si el Pico los informa. Cada sensor aporta su última muestra vigente; no hay sincronización física entre cámaras. Los campos sin señal quedan en null. Una captura sin sensores sigue siendo un registro del disparo, identificado como tal al inspeccionar sus datos.

El original se guarda primero en SQLite, en /var/lib/rovssa/events.sqlite3. La PC copia automáticamente los archivos pendientes a la base local del navegador, comprueba su huella y los muestra en **Historial en esta PC**. Al recargar, reiniciar o reconectar se reanuda la copia, sin borrar el original. Cada navegador tiene su propio historial. Limpiar los datos del navegador borra su copia y sus confirmaciones locales. Volver a conectar permite recuperar los archivos de la Jetson. Para respaldarlos fuera del navegador usá **Descargar JSON**. En la demo la base se guarda en .rovssa-demo dentro del proyecto.

La red del router alcanza para registrar desde la PC. Sin Internet podés hacer toda la patrulla y certificar luego. Si se corta el enlace PC–rover, la consola avisa que no puede consultar pendientes. Si el pedido llegó antes del corte, el original queda en la Jetson. Con el enlace ya caído, un botón de la PC no puede disparar una captura. En Linux el servicio también acepta una señal local de registro. Para probar en banco: **sudo systemctl kill --kill-who=main --signal=SIGUSR1 rovssa.service**. Vincular un pulsador físico o un canal de la radio a esa señal requiere conocer el cableado y el firmware del equipo.

## Firma de captura y verificación

**Operación** recibe video y telemetría y registra el evento. En ese instante la Jetson firma los bytes del contenido con ECDSA secp256k1 y SHA-256, incluso sin Internet. La descarga es un JSON con el contenido exacto en el campo de texto `payload` y la firma en `signature`. Para inspeccionarlo en Python, usá `json.loads(registro["payload"])`. SQLite conserva ese archivo completo. Su hash de transferencia verifica la copia a la PC. El identificador del token es el SHA-256 del contenido firmado, independiente del formato exterior del sobre.

**Registros** abre una captura del historial o un JSON externo, reconstruye ambas vistas y sus lecturas, y separa dos preguntas:

1. **Origen.** La PC verifica localmente la firma con la clave pública del rover. En la primera conexión toma esa identidad de la Jetson a través del origen HTTPS autenticado y la recuerda en ese navegador. Una identidad diferente genera una alerta y no reemplaza automáticamente a la conocida. Para una estación de verificación independiente, fijá la clave pública oficial en `VITE_ROVER_PUBLIC_KEY` antes de compilar, y la dirección de colección en `VITE_OBSERVATION_CONTRACT`. Obtené la clave pública desde /api/identity en la Jetson de confianza. Entregá esos identificadores al verificador por un canal independiente del archivo a verificar.
2. **Publicación.** En **Colección e identidad del rover**, desplegá una colección en Fuji con la wallet emisora una sola vez. Anotá la dirección. Si hay una colección anterior que solo aceptaba huellas, conservá su dirección para consultas históricas y creá una nueva para los registros firmados. La nueva colección fija la identidad del rover y la cuenta emisora al desplegarse. Seleccioná el registro y pulsá **Emitir token**. El contrato exige tanto la transacción de la wallet emisora como una firma del rover válida para ese contenido. Solo se publican la huella y la prueba criptográfica. La foto y la telemetría quedan en el JSON. [Red y fondos de prueba](https://build.avax.network/docs/primary-network).
3. **Verificar en Avalanche** consulta la colección indicada y muestra el titular del token cuando encuentra la huella. Es una consulta de lectura, con conexión a Internet. Una consulta fallida deja el estado pendiente. Los archivos anteriores se pueden inspeccionar y consultar en la colección histórica por su hash original; la consola los identifica como registros sin firma de origen y deshabilita su emisión.
4. Para el ensayo, descargá una captura firmada, cambiá un dato dentro de `payload` en una copia y abrila desde **Registros**. Deberías ver **Firma inválida para este rover**. La hora indicada en la captura procede del reloj del robot. La inclusión en la cadena acredita la publicación posterior.

La clave privada de captura se genera en el equipo y se conserva en /var/lib/rovssa/capture-key.pem junto a la base (en .rovssa-demo para la simulación). Resguardá esa clave con acceso restringido. Nunca la copies al frontend ni la compartas con un verificador. Reinstalar el servicio conserva su directorio de estado. Si se pierde la clave o se compromete, provisioná una identidad y colección nuevas, y guardá las referencias antiguas para verificar el historial.

**Diagnóstico** muestra el enlace de la PC, la API de la Jetson y las lecturas recientes por sensor. Seleccioná un nodo para consultar sus mensajes de solo lectura. Al perder enlace conserva los últimos mensajes recibidos durante la sesión y marca los sensores como desconocidos. El rover guarda en memoria hasta 40 mensajes recientes por componente. Para investigar reinicios o el proceso completo, usá el journal del servicio en la Jetson.

Se eligió una observación por evento para que el operador pueda decidir qué preservar y trabajar sin Internet durante una patrulla. Para agro, el mismo esquema admite incorporar un conteo y versión del modelo en una futura versión del archivo. Emitir un token por cuadro exigiría una transacción por cuadro y dificultaría la operación en campo.

## Verificación de desarrollo

~~~sh
python -m pip install -r requirements-test.txt
python -X utf8 -m unittest discover -s tests -v
node deploy/compile-contract.mjs
npm run build
~~~

El contrato usa ERC-721 de OpenZeppelin. El compilador genera el artefacto que usa la wallet para desplegar y emitir. El visor del mapa usa teselas de OpenStreetMap y requiere Internet para el fondo cartográfico. La posición numérica, el video y la captura funcionan sobre la LAN.
