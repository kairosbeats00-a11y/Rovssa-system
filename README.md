# ROVSSA — Mission Control

Sistema de control terrestre (GCS) para el rover ROVSSA. Interfaz web React que se comunica con un servidor Flask corriendo en la Jetson Nano del rover.

---

## Instalación y puesta en marcha

### Requisitos previos

- Node.js 18+ (para el frontend)
- Python 3.8+ (para el servidor Jetson)
- La laptop y la Jetson deben estar en la **misma red local**

---

### 1. Frontend (laptop)

```bash
# Clonar el repositorio
git clone https://github.com/kairosbeats00-a11y/Rovssa-vercel.git
cd Rovssa-vercel

# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
npm run dev
```

Abrir el navegador en `http://localhost:5173`.

Para un build de producción (deploy en Vercel u otro hosting):
```bash
npm run build
```

---

### 2. Servidor Jetson Nano

Conectarse a la Jetson por SSH y ejecutar los siguientes pasos.

**Instalar dependencias Python:**
```bash
sudo pip3 install flask pyserial smbus2 numpy adafruit-circuitpython-bno08x
sudo apt install python3-opencv gstreamer1.0-tools gstreamer1.0-plugins-good -y

# Permisos para el puerto serial del Pico
sudo usermod -a -G dialout $USER
# (cerrar sesión y volver a entrar, o ejecutar:)
sudo chmod 666 /dev/ttyACM0
```

**Clonar el repo en la Jetson (si no está):**
```bash
git clone https://github.com/kairosbeats00-a11y/Rovssa-vercel.git
cd Rovssa-vercel
```

**Iniciar el servidor:**
```bash
python3 "entorno de simulacion/jetson_server.py"
```

El servidor queda escuchando en `http://0.0.0.0:8000`.

---

### 3. Conectar el frontend al rover

1. Abrir la app en el navegador.
2. Hacer click en el ícono ⚙ (esquina superior derecha).
3. Ingresar la IP de la Jetson (ej: `192.168.1.100`) y guardar.

La IP también se puede fijar en tiempo de build con la variable de entorno:
```bash
VITE_JETSON_IP=192.168.1.100 npm run build
```

---

### 4. Verificar la conexión

Con el servidor corriendo, acceder desde cualquier navegador en la red:
```
http://<IP_JETSON>:8000/status
```

Debe devolver un JSON con el estado del hardware (Pico, GPIO, GPS, etc.).

---

### Conexiones de hardware (referencia rápida)

| Componente | Conexión |
|---|---|
| Pico RP2040 | USB-A → micro-USB → `/dev/ttyACM0` |
| IMU BNO085 | I2C addr `0x4B` — SDA pin 3, SCL pin 5 |
| HC-SR04 Frontal | TRIG GPIO17 (pin 11), ECHO GPIO27 (pin 13) |
| HC-SR04 Izquierda | TRIG GPIO22 (pin 15), ECHO GPIO23 (pin 16) |
| HC-SR04 Derecha | TRIG GPIO24 (pin 18), ECHO GPIO10 (pin 19) |
| Cámara FPV | CSI ribbon → conector CSI Jetson |
| Cámara Brazo | USB → `/dev/video1` |
| GPS NEO-M8N | USB/Serial |

---

## Controles de teclado (modo MANUAL)

| Tecla | Acción |
|---|---|
| `W` / `↑` | Avanzar |
| `S` / `↓` | Retroceder |
| `A` / `←` | Girar izquierda |
| `D` / `→` | Girar derecha |
| `Espacio` | Stop |
| `E` | Emergency Stop (toggle) |
| `R` | Reset odometría |
