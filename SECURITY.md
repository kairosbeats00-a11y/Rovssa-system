# ROVSSA: comunicaciones y control seguro

## Estado de esta revisión

Cambios de software y pruebas sin actuadores. No están instalados ni validados en la Jetson. No afirmar todavía que el rover físico quedó asegurado o que TLS está desplegado. El certificado real, la contraseña y la configuración de red se generan en el equipo de destino, nunca se guardan en Git.

En la versión de competencia el mando de radio conduce el rover. ROVSSA lee del Pico, rechaza comandos de conducción por red y no inicia el escritor serial. Las protecciones de conducción por red descritas abajo corresponden al código reservado para validación futura. AUTO/AI, misiones autónomas y ZeroMQ/SO101 están deshabilitados: no se abren puertos 5555/5556 ni se conecta el brazo. Para habilitarlos en el futuro se necesita transporte autenticado, límites del actuador y validación de parada. El constructor visual conserva su código, pero no puede despachar misiones.

## Qué cambió

- Consola, video, SSE y comandos usan el mismo origen HTTPS, con autenticación Basic de nginx sobre TLS. No se almacenan secretos en React ni localStorage.
- El backend solo escucha en 127.0.0.1:8000. Cada petición exige un secreto del proxy y conexión desde loopback. El proxy sobrescribe el encabezado para impedir que lo elija un cliente.
- Se eliminó CORS abierto. Las operaciones de escritura requieren Origin HTTPS exacto, encabezado personalizado y JSON. Límite de cuerpo: 16 KiB. El proxy limita solicitudes por IP.
- Arranque bloqueado y rearme explícito. Límites de entrada: vx [-0.7,0.7], omega [-0.6,0.6], valores numéricos finitos. Son los límites de la interfaz anterior, NO una certificación de velocidad segura física.
- Heartbeat cada 0,5 s; caduca a los 2 s. Durante movimiento, una orden de conducción caduca a los 0,5 s. La expiración bloquea el control hasta rearme manual.
- Una generación de control y un contador de secuencia rechazan comandos atrasados o fuera de orden. La última orden sustituye a la anterior; una parada elimina movimiento pendiente. El escritor vuelve a comprobar el interlock antes de escribir al puerto serial.
- Pérdida de foco/visibilidad limpia teclas y solicita parada; la UI informa órdenes no confirmadas y no declara que el robot está físicamente detenido.
- Configuración ausente: el backend no inicia. Entorno simulado: no inicializa hardware. Errores de ultrasonido dejan distancia 0 (desconocida/bloqueada); GPS expira a los 3 s. No interpretar 0 como una medición física precisa.
- Corregido NameError en el registro de acciones y bloqueo por adquisición anidada del lock del ejecutor experimental.

## Arquitectura de despliegue

PC (navegador) -> HTTPS:443 nginx (autenticación) -> HTTP loopback:8000 Flask -> puerto USB Pico.

El salto HTTP es exclusivamente dentro de la Jetson, no por la LAN. No poner el proxy en otra máquina con este diseño. No exponer Flask, Vite ni puertos de brazo a la red. No sirve publicar esta consola en Vercel y conectarla directamente a una IP privada: debe servirse desde el proxy del rover.

## Preparación en Jetson/Linux

1. Respaldar la versión actualmente operativa y el firmware Pico. Desconectar potencia de motores/brazo para las primeras pruebas. Utilizar Python compatible con Flask 3.1 (Python >=3.9; recomendado 3.10+) y verificar compatibilidad de las bibliotecas de JetPack en un entorno propio. Esta revisión no cambia JetPack ni instala nada en el robot.
2. Compilar frontend con `npm ci` y `npm run build`. Copiar `dist/` a `/srv/rovssa/dist`, y los Python del directorio `entorno de simulacion` a `/srv/rovssa/backend`. Crear el entorno Python con Flask 3.1.3 y pyserial 3.5; conservar/configurar las bibliotecas específicas de sensores/cámaras según la Jetson real.
3. Instalar nginx y apache2-utils en la Jetson. Crear `/etc/rovssa` con permisos restringidos. Crear una cuenta de operador con `sudo htpasswd -cB /etc/rovssa/operators.htpasswd operador` (contraseña fuerte por prompt, nunca en argumentos). En cuentas posteriores omitir `-c`, porque reemplaza el archivo. Dar lectura al grupo del worker nginx y modo 640; usar un usuario de sistema separado para el backend. No ejecutar Flask como root; usar grupos dialout/video/i2c/gpio que correspondan y no `chmod 666`.
4. Elegir un nombre DNS estable, por ejemplo `rover.test`, que la PC resuelva a la Jetson. Emitir un certificado para ese nombre mediante una CA confiable para la PC; en LAN aislada puede ser una CA privada. Instalar solo el certificado público de la CA en los clientes. La clave privada de la CA no debe copiarse al rover. El certificado del servidor necesita SAN del nombre usado. Mantener la hora de ambos equipos correcta. No desactivar validación, no usar `curl -k` ni aceptar avisos del navegador como solución.
5. Copiar certificado/cadena y clave de servidor a `/etc/rovssa/server-chain.pem` y `/etc/rovssa/server-key.pem`; clave solo legible por el proceso que termina TLS. Generar configuración desde la raíz del repositorio:

```sh
python3 deploy/configure.py --hostname rover.test --cert /etc/rovssa/server-chain.pem --key /etc/rovssa/server-key.pem
```

Se crea `.security/` (ignorada por Git) con `nginx.conf` y `backend.env`. No imprime el secreto. Se niega a sobrescribir credenciales existentes. La configuración inicia en SIMULACIÓN.

6. Instalar la configuración generada dentro del contexto http de nginx (por ejemplo sites-enabled en Ubuntu). El archivo contiene el secreto del proxy: solo root debe leerlo. Verificar `sudo nginx -t` antes de recargar nginx. Configurar `backend.env` como EnvironmentFile del servicio backend con permisos 600; iniciar `/srv/rovssa/backend/jetson_server.py` desde el Python del entorno dedicado. No usar múltiples workers: el estado y el hardware tienen un solo propietario.
7. Abrir únicamente 443 desde las PCs de control y SSH desde equipos administradores. Verificar reglas de firewall sin perder acceso administrativo. No abrir 8000, 5555, 5556 o 5173 a la LAN. El secreto protege también el acceso accidental desde procesos locales no autorizados; un administrador comprometido de la Jetson está fuera de este modelo.

## Verificación antes de operar

Desde una PC, con la CA validada por un canal confiable:

```sh
python3 deploy/verify_tls.py https://rover.test/ --ca ruta/a/ca-publica.pem
python3 deploy/verify_tls.py https://rover.test/api/status --ca ruta/a/ca-publica.pem
```

Comprueba cadena, nombre y vigencia mediante la biblioteca TLS del sistema, además del desafío 401 para solicitudes sin contraseña. Si la CA ya está en el almacén confiable del entorno Python, se puede omitir `--ca`. Una CA privada instalada solo en el navegador puede requerir `--ca` para Python.

Luego abrir https://rover.test, iniciar sesión y verificar estado, SSE y video. El navegador valida TLS en todos esos recursos. Probar contraseña errónea, nombre equivocado, certificado no confiable, peticiones sin Origin y acceso al puerto 8000 desde otra PC. No seguir ante un error de certificado. Renovar certificados antes de vencer y repetir la verificación. Cerrar completamente el navegador para retirar credenciales Basic de esa sesión; no existe un botón fiable de logout con este esquema.

En simulación no hay sensores ni video real; no se considera una prueba del robot. Solo después de pruebas de banco, cambiar ROVSSA_SIMULATION a 0 en el EnvironmentFile y reiniciar el servicio con motores sin carga. El estado inicial debe ser bloqueado. Confirmar parada ante pérdida de WiFi, cierre de pestaña, pérdida de foco, pérdida serial y reinicio. Confirmar que un rearme no repite movimiento anterior y medir tiempos reales.

## Pruebas de desarrollo

```sh
python -m pip install -r requirements-test.txt
python -X utf8 -m unittest discover -s tests -v
npm run build
```

Los tests usan reloj simulado, salidas falsas, cliente Flask y un servidor TLS efímero local. No necesitan el rover. Las pruebas TLS ejercitan la validación de certificados del cliente; no sustituyen `nginx -t` ni una prueba extremo a extremo en Jetson.

## Límites importantes

La parada software no es un e-stop físico certificado. Si Python, Linux, serial o la energía fallan, no puede garantizar que el último comando sea interrumpido. Es imprescindible un watchdog independiente en el firmware Pico y una parada física que corte o inhiba actuadores; el firmware no está en este repositorio y no fue modificado. Los tiempos de parada efectivos deben medirse.

El acceso inicial usa una cuenta operadora: no ofrece roles, auditoría por persona ni arbitraje entre múltiples operadores simultáneos. Usar una sola PC/sesión para conducción. La telemetría y cámaras no tienen revocación inmediata de conexiones ya abiertas al cambiar la contraseña; reiniciar las conexiones/servicios al revocar acceso.

No se habilita recolección autónoma ni se declara resuelto el control seguro de SO101. La neutralización del canal ZeroMQ se hizo deshabilitándolo, no añadiendo cifrado a un brazo probado. No se ejecutaron pruebas físicas ni se desplegaron certificados reales.
