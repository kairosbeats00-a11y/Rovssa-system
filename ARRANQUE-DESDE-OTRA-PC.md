# Arrancar ROVSSA desde otra PC

Esta guía usa Windows y PowerShell. Hay tres modos:

| Objetivo | Servidor | Dirección |
|---|---|---|
| Probar en la misma PC | Simulador en Windows | `http://127.0.0.1:8765` |
| Probar el visor desde el celular | Simulador HTTPS en Windows | `https://IP_DE_LA_PC:8766` |
| Operar el rover con cámaras reales | ROVSSA instalado en la Jetson | `https://IP_DE_LA_JETSON` |

## 1. Preparar una PC nueva

1. Instalá Git, Node.js 22.12 o posterior de la rama 22 y Python 3.11 o 3.12 para Windows. Abrí una terminal PowerShell nueva y comprobá que `git --version`, `node --version`, `npm.cmd --version` y `py --version` respondan.
2. Desde una carpeta donde quieras guardar el proyecto, ejecutá:

   ```powershell
   git clone --branch main https://github.com/kairosbeats00-a11y/Rovssa-system.git
   Set-Location Rovssa-system
   npm.cmd ci
   npm.cmd run build
   py -3 -m venv .venv
   & .\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
   ```

   Si GitHub pide acceso, iniciá sesión con una cuenta de GitHub autorizada para el repositorio. Ejecutá los comandos siguientes desde la raíz del proyecto, donde están `deploy` y `dist`. El entorno virtual se usa invocando su Python directamente. Si `py` no existe pero `python --version` funciona, usá `python -m venv .venv`.

   Si ya tenés `ROVSSA-listo.zip`, extraelo y entrá a la carpeta `ROVSSA`. El paquete trae `dist` compilado. Para correr la demo desde ese paquete, alcanzan los dos comandos de Python del bloque.

## 2. Demo local en la PC

```powershell
$env:ROVSSA_DEMO_PORT = '8765'
& .\.venv\Scripts\python.exe deploy/demo.py
```

Dejá la terminal abierta. Desde **esa misma PC**, abrí [http://127.0.0.1:8765](http://127.0.0.1:8765). La cabecera debe mostrar **Simulación**. Probá **VR (Experimental) → Patrón de prueba → Abrir visor**. La cuadrícula es generada por el navegador. Para probar registros, en **Operación** tocá **Registrar evento** y buscá la captura en **Registros**. Detené el servidor con Ctrl+C.

## 3. Demo HTTPS para el celular

1. Conectá la PC y el celular a la misma red del router. En la PC ejecutá `ipconfig` y anotá la IPv4 del adaptador conectado al router. Si la PC está por cable, usá su adaptador Ethernet. En el ejemplo, reemplazá `192.168.1.50` por **la IP de esta PC**.
2. Generá un certificado para esa IP y una contraseña local para el operador. Hacelo una vez por IP. Si la carpeta de esa IP ya existe, reutilizá sus archivos.

   ```powershell
   $lanIp = '192.168.1.50'
   $tlsDir = ".security-pc/vr-$lanIp"
   & .\.venv\Scripts\python.exe deploy/prepare.py $lanIp --output $tlsDir
   if ($LASTEXITCODE -ne 0) { throw 'Revisá la generación del certificado antes de seguir.' }
   & .\.venv\Scripts\python.exe -c "from pathlib import Path; import secrets, sys; Path(sys.argv[1]).write_text(secrets.token_urlsafe(15), encoding='utf-8')" "$tlsDir/password.txt"
   Copy-Item -LiteralPath "$tlsDir/ca-public.pem" -Destination "$tlsDir/ROVSSA-VR-CA.crt"
   ```

3. En PowerShell, desde la raíz del proyecto, arrancá la demo. Si abriste otra terminal, repetí las dos primeras asignaciones con tu IP.

   ```powershell
   $lanIp = '192.168.1.50'
   $tlsDir = ".security-pc/vr-$lanIp"
   $env:ROVSSA_DEMO_PORT = '8766'
   & .\.venv\Scripts\python.exe deploy/demo.py --lan-ip $lanIp --cert "$tlsDir/jetson/server-chain.pem" --key "$tlsDir/jetson/server-key.pem" --password-file "$tlsDir/password.txt"
   ```

   La terminal muestra la URL HTTPS. En una segunda terminal de la misma PC podés comprobar el certificado y la autenticación sin enviar la contraseña:

   ```powershell
   $lanIp = '192.168.1.50'
   curl.exe --cacert ".security-pc/vr-$lanIp/ca-public.pem" -sS -o NUL -w '%{http_code}' "https://${lanIp}:8766/"
   ```

   Debe devolver **401**. Significa que el servidor respondió con un certificado válido para esa CA y pidió credenciales.
4. Pasá al celular únicamente `ROVSSA-VR-CA.crt`, usando una copia obtenida de la PC que generó el certificado. En Android, buscá **Instalar certificado** en Ajustes y elegí **Certificado de CA**. Una CA instalada amplía la confianza del dispositivo. Retirá la de esta demo al terminar si ya no la necesitás. Conservá en la PC los archivos `.key` y `password.txt`.
5. En Chrome del celular abrí la URL de la terminal, por ejemplo `https://192.168.1.50:8766`. Ingresá como `operador`. Consultá tu contraseña en la PC con `Get-Content ".security-pc/vr-$lanIp/password.txt"`. Elegí **VR (Experimental) → Abrir visor**. Activá **Patrón de prueba** para ver la cuadrícula. Si Android no gira automáticamente, habilitá la rotación y girá el teléfono.

### Si el celular no puede entrar

- **La PC recibe 401 pero el celular se queda cargando.** Confirmá que el celular esté en la red correcta y que el router no aísle a los equipos. Una red de invitados puede bloquear conexiones entre dispositivos.
- **El firewall bloquea el puerto.** Si tenés permiso de administrador y es una red propia, podés habilitar TCP 8766 solo en la IP de la demo y para la subred local. En otra terminal PowerShell **como administrador**, ejecutá este bloque. Dejá esa terminal abierta y pulsá Enter al terminar la prueba para quitar la regla.

  ```powershell
  $lanIp = '192.168.1.50'
  $rule = 'ROVSSA-demo-' + [guid]::NewGuid().ToString()
  try {
      New-NetFirewallRule -Name $rule -DisplayName 'ROVSSA demo temporal' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $lanIp -LocalPort 8766 -RemoteAddress LocalSubnet -Profile Any -ErrorAction Stop | Out-Null
      Read-Host 'Presioná Enter al terminar para retirar la regla'
  } finally {
      Remove-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue
  }
  ```

- **El navegador avisa que el certificado no es confiable.** Verificá que instalaste la CA correspondiente y que la IP en la URL coincide con la usada para generar el certificado. Una IP nueva requiere un certificado para esa IP.
- **El servidor dice que el puerto está ocupado.** Cerrá la instancia anterior desde su terminal con Ctrl+C. Podés dejar corriendo a la vez la demo de PC en 8765 y la de celular en 8766.

## 4. Usar la Jetson y las cámaras reales

Si la Jetson ya está instalada, encendela y conectá la laptop y el celular a la red del rover. Abrí **la dirección HTTPS de la Jetson** con su CA pública y su cuenta de operador. El servidor real vive en la Jetson. Para el visor, la Jetson tiene que servir la interfaz actualizada y la cámara elegida debe estar transmitiendo. En **VR (Experimental)** desactivá **Patrón de prueba**.

Para preparar el paquete desde un clon, después de compilar:

```powershell
& .\.venv\Scripts\python.exe deploy/package.py
```

Encontrás el ZIP en `release/ROVSSA-listo.zip`. Para instalar desde cero, seguí [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md). Si el rover ya funciona y solo querés incorporar la interfaz VR, respaldá y actualizá los archivos estáticos de `/srv/rovssa/dist` con la carpeta `dist` recién compilada. Probá primero las dos cámaras en **Operación** y después en el visor.

## 5. Retomar el proyecto con Codex

En la laptop, instalá la [app de escritorio de ChatGPT para Windows](https://learn.chatgpt.com/docs/app/windows). Entrá con una cuenta que tenga Codex habilitado, elegí **Codex**, agregá la carpeta clonada como proyecto y abrí un chat en modo local. La laptop necesita Internet para usar Codex y acceso a la red de la Jetson para diagnosticarla. Comprobá primero desde esa laptop que podés abrir el HTTPS del rover y, si vas a administrarlo, que tu acceso SSH funciona.

Podés iniciar el nuevo chat con este mensaje:

> Trabajá en este clon de ROVSSA. Leé ARRANQUE-DESDE-OTRA-PC.md y PUESTA-EN-MARCHA.md. La laptop está conectada al router de la Jetson. Ayudame a verificar el servidor y las dos cámaras. Primero identificá la IP y revisá el estado actual antes de aplicar cambios.

Git transporta el código y la guía. La configuración local, los certificados, el archivo de capturas, la identidad de firma y la wallet se administran por separado. Para continuar un chat existente en otro equipo, consultá las [conexiones y el traspaso entre hosts de Codex](https://learn.chatgpt.com/docs/remote-connections). Para operar los equipos del rover, ejecutá Codex donde la Jetson sea alcanzable por red.
