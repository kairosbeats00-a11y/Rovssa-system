#!/usr/bin/env python3
"""
ROVSSA Jetson Server — Modo Hardware
Reemplaza simulador_server.py. Corre directamente en la Jetson Nano.

═══════════════════════════════════════════════════════════════════════════
INSTALACIÓN (correr una sola vez):
    sudo pip3 install flask pyserial smbus2 numpy
    sudo apt install python3-opencv -y
    # Jetson.GPIO ya viene con JetPack. Si no:
    sudo pip3 install Jetson.GPIO
    # Permisos serial USB (Pico):
    sudo usermod -a -G dialout $USER   # requiere re-login o:
    sudo chmod 666 /dev/ttyACM0

═══════════════════════════════════════════════════════════════════════════
PINOUT HC-SR04 — Jetson Nano 40-pin header (BCM numbering):

    Sensor      TRIG              ECHO
    ─────────────────────────────────────────
    Frontal:  GPIO17 (pin 11)   GPIO27 (pin 13)
    Izquierda:GPIO22 (pin 15)   GPIO23 (pin 16)
    Derecha:  GPIO24 (pin 18)   GPIO10 (pin 19)

    Alimentación sensores: 5V (pin 2 o 4) + GND (pin 6, 9, 14...)
    ⚠️  ECHO de HC-SR04 es 5V — usar divisor resistivo 1kΩ+2kΩ al GPIO.

IMU MPU6050:
    VCC=3.3V (pin 1), GND (pin 6), SDA (pin 3), SCL (pin 5)
    Dirección I2C: 0x68

Pico:
    Cable USB-A → micro-USB entre Jetson y Pico → /dev/ttyACM0

Cámara FPV:
    CSI (ribbon) → conector CSI Jetson Nano, o USB → /dev/video0

Cámara Brazo (USB):
    USB → /dev/video1  (ajustar CAMERA_ARM_USB_INDEX si es distinto)

═══════════════════════════════════════════════════════════════════════════
EJECUCIÓN:
    python3 jetson_server.py

El frontend (React) se conecta a http://<IP_JETSON>:8000
═══════════════════════════════════════════════════════════════════════════
"""

from flask import Flask, Response, request, jsonify
import threading
import time
import json
import math
import queue
import sys
import os

# ── Importaciones de hardware (con fallbacks seguros) ─────────────────────────

try:
    import serial
    import serial.tools.list_ports
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False
    print("⚠️  pyserial no instalado. pip3 install pyserial")

I2C_AVAILABLE = False

import subprocess as _subprocess

def _check_gstreamer():
    """Verifica que gst-launch-1.0 está disponible en el sistema."""
    try:
        r = _subprocess.run(
            ['gst-launch-1.0', '--version'],
            stdout=_subprocess.PIPE, stderr=_subprocess.PIPE, timeout=3
        )
        return r.returncode == 0
    except Exception:
        return False

GST_AVAILABLE = _check_gstreamer()
if GST_AVAILABLE:
    print("✅ GStreamer disponible")
else:
    print("⚠️  GStreamer no encontrado — video deshabilitado")
# Alias para no cambiar el resto del código
CV2_AVAILABLE = False

# Inicializar BNO085 antes de GPIO para evitar conflicto de bus I2C
_bno_instance = None
try:
    import board as _board
    import busio as _busio
    from adafruit_bno08x.i2c import BNO08X_I2C as _BNO08X_I2C
    from adafruit_bno08x import BNO_REPORT_ROTATION_VECTOR as _BNO_RV
    _i2c_bus = _busio.I2C(_board.SCL, _board.SDA)
    _bno_instance = _BNO08X_I2C(_i2c_bus, address=0x4B)
    _bno_instance.enable_feature(_BNO_RV)
    print("✅ BNO085 pre-inicializado")
except Exception as _e:
    print(f"⚠️  BNO085 no disponible: {_e}")

try:
    import Jetson.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    GPIO_AVAILABLE = True
    print("✅ Jetson.GPIO disponible")
except Exception:
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO_AVAILABLE = True
        print("✅ RPi.GPIO disponible (modo compatibilidad)")
    except Exception:
        GPIO_AVAILABLE = False
        print("⚠️  GPIO no disponible — ultrasonidos deshabilitados")

# ── Módulos de navegación autónoma (modo AI) ──────────────────────────────────
from mission_executor import executor_loop, start_mission, stop_mission, get_mission_status
from hardware_interface import HardwareInterface
from yolo_detector import yolo_detector_thread
from gps_reader import gps_reader_thread

app = Flask(__name__)

# =============================================================================
# CONFIGURACIÓN — Ajustar según hardware real
# =============================================================================

# Puerto serial del Pico (USB CDC)
PICO_PORTS = ["/dev/ttyACM0", "/dev/ttyACM1", "/dev/ttyUSB0", "/dev/ttyUSB1"]
PICO_BAUD  = 115200

# I2C — MPU6050
I2C_BUS       = 1       # sudo i2cdetect -y 1
MPU6050_ADDR  = 0x68    # AD0=GND → 0x68, AD0=VCC → 0x69

# Pines GPIO HC-SR04 (BCM numbering)
US_FRONT_TRIG = 17;  US_FRONT_ECHO = 27   # pines 11 y 13
US_LEFT_TRIG  = 22;  US_LEFT_ECHO  = 23   # pines 15 y 16
US_RIGHT_TRIG = 24;  US_RIGHT_ECHO = 10   # pines 18 y 19

# Cámara FPV CSI
CAMERA_CSI_PIPELINE = (
    "nvarguscamerasrc ! "
    "video/x-raw(memory:NVMM),width=640,height=480,framerate=30/1 ! "
    "nvvidconv ! video/x-raw,format=BGRx ! "
    "videoconvert ! video/x-raw,format=BGR ! appsink drop=1"
)
CAMERA_USB_INDEX = 0    # /dev/video0 — fallback CSI si no hay CSI

# ── CÁMARA BRAZO (USB) ────────────────────────────────────────────────────────
# Ajustar al índice real: ls /dev/video*
# Si la CSI ocupa /dev/video0, la USB suele quedar en /dev/video1
CAMERA_ARM_USB_INDEX = 1   # → /dev/video1

# Odometría — ajustar según tu rover real
WHEEL_DIAMETER_M  = 0.12    # diámetro rueda en metros (medir con regla)
WHEELBASE_M       = 0.35    # distancia entre ruedas izq y der
ENCODER_CPR       = 13440   # del firmware: 64 CPR × 210:1 × 4 flancos
WHEEL_CIRCUMFERENCE = math.pi * WHEEL_DIAMETER_M
DIST_PER_TICK     = WHEEL_CIRCUMFERENCE / ENCODER_CPR

# Umbral de obstáculo para cerebro autónomo (metros)
OBSTACLE_DIST_M = 0.40    # frenar si hay algo a menos de 40 cm

# =============================================================================
# ESTADO COMPARTIDO (protegido por locks)
# =============================================================================

_telem_lock = threading.Lock()
current_telemetry = {
    "pitch": 0.0,
    "roll":  0.0,
    "yaw":   0.0,
    "distancia_frontal":   2.0,
    "distancia_izquierda": 2.0,
    "distancia_derecha":   2.0,
}

_pico_lock = threading.Lock()
pico_state = {
    "enc":  [0, 0, 0, 0],   # FL, FR, RL, RR
    "mode": "GCS",
    "ch":   [1500] * 6,
    "connected": False,
}

_odom_lock = threading.Lock()
odometry = {"x": 0.0, "y": 0.0, "theta": 0.0}
_prev_enc = [0, 0, 0, 0]

# Modos de operación: MANUAL, AUTO, ESTOP
_mode_lock = threading.Lock()
rover_mode  = "MANUAL"    # cambiado por el frontend vía POST /set_mode
estop_active = False

# Cola de comandos para el hilo serial writer
_cmd_queue = queue.Queue(maxsize=10)

# Frame JPEG actual — cámara CSI principal
_frame_lock = threading.Lock()
current_frame = None

# Frame JPEG actual — cámara USB brazo  ← NUEVO
_frame_usb_lock = threading.Lock()
current_frame_usb = None

# ── Estado GPS (se puebla cuando se integre el M8N) ──────────────────────────
_gps_lock = threading.Lock()
gps_state = {"fix": False, "lat": 0.0, "lon": 0.0, "alt": 0.0, "sats": 0, "speed_ms": 0.0}

# ── Detecciones YOLO (se puebla cuando se integre la inferencia) ──────────────
_yolo_lock = threading.Lock()
yolo_detections = {}   # {"bottle": {"cx": 320, "cy": 240, "area": 5000}, ...}
# =============================================================================
# CORS
# =============================================================================

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
    response.headers.add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    return response

@app.route('/', methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def options_handler(path=''):
    return '', 204

# =============================================================================
# HILO: LECTOR SERIAL DEL PICO
# Recibe JSON lines: {"enc":[FL,FR,RL,RR],"mode":"RC","ch":[...]}
# =============================================================================

def find_pico_port():
    """Busca el puerto serial del Pico automáticamente."""
    for port_path in PICO_PORTS:
        if os.path.exists(port_path):
            return port_path
    # Buscar por VID/PID del Pico (2E8A:0005)
    for port in serial.tools.list_ports.comports():
        if port.vid == 0x2E8A:
            return port.device
    return None

def serial_reader_thread():
    global _prev_enc
    print("🔌 Hilo serial reader iniciado...")

    while True:
        port = find_pico_port() if SERIAL_AVAILABLE else None
        if not port:
            print("⚠️  Pico no encontrado. Reintentando en 3s...")
            with _pico_lock:
                pico_state["connected"] = False
            time.sleep(3)
            continue

        try:
            ser = serial.Serial(port, PICO_BAUD, timeout=1.0)
            print(f"✅ Pico conectado en {port}")
            with _pico_lock:
                pico_state["connected"] = True

            buf = ""
            while True:
                data = ser.read(ser.in_waiting or 1)
                if not data:
                    continue
                buf += data.decode('utf-8', errors='ignore')
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                        enc = msg.get("enc", [0, 0, 0, 0])
                        mode = msg.get("mode", "GCS")
                        ch = msg.get("ch", [1500] * 6)

                        with _pico_lock:
                            pico_state["enc"]  = enc
                            pico_state["mode"] = mode
                            pico_state["ch"]   = ch

                        # Actualizar odometría
                        _update_odometry(enc)

                    except (json.JSONDecodeError, KeyError):
                        pass  # línea de debug del Pico ("Pico listo.", etc.)

        except serial.SerialException as e:
            print(f"❌ Error serial Pico: {e}. Reintentando en 3s...")
            with _pico_lock:
                pico_state["connected"] = False
            time.sleep(3)

def _update_odometry(enc_new):
    global _prev_enc
    with _odom_lock:
        # Δ encoder de cada rueda
        d_fl = enc_new[0] - _prev_enc[0]
        d_fr = enc_new[1] - _prev_enc[1]
        d_rl = enc_new[2] - _prev_enc[2]
        d_rr = enc_new[3] - _prev_enc[3]
        _prev_enc = list(enc_new)

        # Distancia media izq / der (skid-steer)
        dl = (d_fl + d_rl) / 2.0 * DIST_PER_TICK
        dr = (d_fr + d_rr) / 2.0 * DIST_PER_TICK

        dx     = (dl + dr) / 2.0
        dtheta = (dr - dl) / WHEELBASE_M   # radianes

        theta_rad = math.radians(odometry["theta"])
        odometry["x"]     += dx * math.cos(theta_rad)
        odometry["y"]     += dx * math.sin(theta_rad)
        odometry["theta"]  = (odometry["theta"] + math.degrees(dtheta)) % 360.0

# =============================================================================
# HILO: ESCRITOR SERIAL — envía comandos al Pico
# =============================================================================

def serial_writer_thread():
    """Lee de _cmd_queue y escribe al Pico."""
    print("📤 Hilo serial writer iniciado...")
    ser = None

    while True:
        # Intentar tener la conexión serial
        if ser is None or not ser.is_open:
            port = find_pico_port() if SERIAL_AVAILABLE else None
            if port:
                try:
                    ser = serial.Serial(port, PICO_BAUD, timeout=1.0)
                except Exception:
                    ser = None
            if ser is None:
                time.sleep(1)
                continue

        try:
            cmd = _cmd_queue.get(timeout=0.5)
            line = json.dumps(cmd) + "\n"
            ser.write(line.encode('utf-8'))
        except queue.Empty:
            pass
        except serial.SerialException:
            ser = None

def send_to_pico(cmd: dict):
    """Helper seguro para encolar un comando al Pico."""
    try:
        _cmd_queue.put_nowait(cmd)
    except queue.Full:
        # Descartar el más viejo y meter el nuevo
        try:
            _cmd_queue.get_nowait()
            _cmd_queue.put_nowait(cmd)
        except Exception:
            pass

# =============================================================================
# HILO: IMU — MPU6050 via I2C
# Registros: https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Register-Map1.pdf
# =============================================================================

# BNO085 — dirección I2C
BNO085_ADDR = 0x4B

# Filtro complementario IMU
_imu_pitch = 0.0
_imu_roll  = 0.0
_imu_yaw   = 0.0
_imu_lock  = threading.Lock()

def imu_thread(bno=None):
    global _imu_pitch, _imu_roll, _imu_yaw

    print(f"🧭 Iniciando IMU BNO085 (addr 0x{BNO085_ADDR:02X})...")

    if bno is None:
        print("⚠️  BNO085 no inicializado — IMU deshabilitada")
        return
    
    print("✅ BNO085 listo")

    import math as _math

    while True:
        try:
            quat = bno.quaternion
            if quat is None:
                time.sleep(0.02)
                continue

            i, j, k, real = quat

            # Quaternion → Euler (pitch, roll, yaw) en grados
            sinr_cosp = 2.0 * (real * i + j * k)
            cosr_cosp = 1.0 - 2.0 * (i * i + j * j)
            pitch = _math.degrees(_math.atan2(sinr_cosp, cosr_cosp))

            sinp = 2.0 * (real * j - k * i)
            sinp = max(-1.0, min(1.0, sinp))
            roll = _math.degrees(_math.asin(sinp))

            siny_cosp = 2.0 * (real * k + i * j)
            cosy_cosp = 1.0 - 2.0 * (j * j + k * k)
            yaw = _math.degrees(_math.atan2(siny_cosp, cosy_cosp))

            with _imu_lock:
                _imu_pitch = pitch
                _imu_roll  = roll
                _imu_yaw   = yaw

            with _telem_lock:
                current_telemetry["pitch"] = round(pitch, 2)
                current_telemetry["roll"]  = round(roll,  2)
                current_telemetry["yaw"]   = round(yaw,   2)

        except Exception as e:
            # El sensor se resetó (vibraciones) — re-habilitar feature y continuar
            try:
                from adafruit_bno08x import BNO_REPORT_ROTATION_VECTOR
                bno.enable_feature(BNO_REPORT_ROTATION_VECTOR)
            except Exception:
                pass
            time.sleep(0.1)

        time.sleep(0.02)  # 50 Hz
# =============================================================================
# HILO: ULTRASONIDOS HC-SR04 (3 sensores)
# =============================================================================

def _setup_ultrasonic_gpio():
    if not GPIO_AVAILABLE:
        return False
    try:
        for pin in [US_FRONT_TRIG, US_LEFT_TRIG, US_RIGHT_TRIG]:
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, False)
        for pin in [US_FRONT_ECHO, US_LEFT_ECHO, US_RIGHT_ECHO]:
            GPIO.setup(pin, GPIO.IN)
        print("✅ GPIO ultrasonidos configurado")
        return True
    except Exception as e:
        print(f"⚠️  Error configurando GPIO: {e}")
        return False

def _measure_distance_cm(trig_pin, echo_pin, timeout_s=0.03):
    """Mide distancia con HC-SR04. Retorna cm, máximo 500 (5 m)."""
    try:
        # Pulso trigger de 10 µs
        GPIO.output(trig_pin, False)
        time.sleep(0.000002)
        GPIO.output(trig_pin, True)
        time.sleep(0.000010)
        GPIO.output(trig_pin, False)

        # Esperar inicio del eco
        t_start = time.time()
        while GPIO.input(echo_pin) == 0:
            if time.time() - t_start > timeout_s:
                return 500.0   # timeout → 5 m (sin obstáculo)
        pulse_start = time.time()

        # Esperar fin del eco
        while GPIO.input(echo_pin) == 1:
            if time.time() - pulse_start > timeout_s:
                return 500.0
        pulse_end = time.time()

        # Convertir a cm (velocidad sonido ≈ 34300 cm/s, ida y vuelta / 2)
        dist_cm = (pulse_end - pulse_start) * 34300 / 2.0
        return min(max(dist_cm, 2.0), 500.0)   # clamp 2..500 cm

    except Exception:
        return 500.0

def ultrasonic_thread():
    if not GPIO_AVAILABLE:
        print("⚠️  GPIO no disponible — ultrasonidos con valores por defecto")
        return

    if not _setup_ultrasonic_gpio():
        return

    print("📡 Hilo ultrasonidos iniciado (50 ms cycle)")

    sensors = [
        ("distancia_frontal",   US_FRONT_TRIG, US_FRONT_ECHO),
        ("distancia_izquierda", US_LEFT_TRIG,  US_LEFT_ECHO),
        ("distancia_derecha",   US_RIGHT_TRIG, US_RIGHT_ECHO),
    ]

    while True:
        for key, trig, echo in sensors:
            dist_m = _measure_distance_cm(trig, echo) / 100.0
            with _telem_lock:
                current_telemetry[key] = round(dist_m, 3)
            time.sleep(0.015)   # 15 ms entre disparos para evitar interferencia

        time.sleep(0.005)

# =============================================================================
# HILO: CÁMARA FPV CSI (principal — sin tocar)
# =============================================================================

JPEG_TMP = "/tmp/rovssa_frame.jpg"
_GST_PIPELINES = [
    "nvarguscamerasrc ! video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1 ! nvvidconv ! video/x-raw,format=I420 ! jpegenc quality=70 ! multifilesink location=/tmp/rovssa_frame.jpg",
    "nvarguscamerasrc ! video/x-raw(memory:NVMM),width=1920,height=1080,framerate=30/1 ! nvvidconv ! video/x-raw,format=I420 ! jpegenc quality=70 ! multifilesink location=/tmp/rovssa_frame.jpg",
    "v4l2src device=/dev/video0 ! videoconvert ! video/x-raw,format=I420 ! videoscale ! video/x-raw,width=640,height=480 ! jpegenc quality=70 ! multifilesink location=/tmp/rovssa_frame.jpg",
]

def _parse_jpeg_frames(pipe_stdout):
    """
    Lee bytes del stdout de gst-launch y los corta en frames JPEG completos.
    JPEG: empieza con FF D8, termina con FF D9.
    Generador — hace yield de bytes de cada frame completo.
    """
    buf = b""
    CHUNK = 65536  # 64 KB por lectura

    while True:
        chunk = pipe_stdout.read(CHUNK)
        if not chunk:
            break
        buf += chunk

        # Buscar y emitir todos los JPEGs completos que haya en el buffer
        while True:
            start = buf.find(b"\xff\xd8")
            if start == -1:
                buf = b""          # no hay inicio — descartar todo
                break
            end = buf.find(b"\xff\xd9", start + 2)
            if end == -1:
                buf = buf[start:]  # inicio encontrado pero sin fin — esperar más datos
                break
            # Frame completo [start : end+2]
            yield buf[start : end + 2]
            buf = buf[end + 2:]

def video_capture_thread():
    global current_frame

    if not GST_AVAILABLE:
        print("⚠️  GStreamer no disponible — video CSI deshabilitado")
        return

    import os as _os

    CMD = [
        'gst-launch-1.0', 'nvarguscamerasrc', '!',
        'video/x-raw(memory:NVMM),width=640,height=480,framerate=15/1', '!',
        'nvvidconv', '!', 'video/x-raw,format=I420', '!',
        'jpegenc', 'quality=50', '!',
        'multifilesink', 'location=/tmp/rovssa_frame.jpg'
    ]

    while True:
        print("📷 Iniciando cámara CSI GStreamer...")
        try:
            proc = _subprocess.Popen(
                CMD,
                stdout=_subprocess.DEVNULL,
                stderr=_subprocess.DEVNULL,
            )
            time.sleep(2.0)
            if proc.poll() is not None:
                print("⚠️  GStreamer CSI cerró inmediatamente. Reintentando en 5s...")
                time.sleep(5)
                continue

            print("✅ Cámara CSI GStreamer abierta")

            while proc.poll() is None:
                try:
                    if _os.path.exists('/tmp/rovssa_frame.jpg'):
                        with open('/tmp/rovssa_frame.jpg', 'rb') as f:
                            data = f.read()
                        if data and len(data) > 500:
                            with _frame_lock:
                                current_frame = data
                except Exception:
                    pass
                time.sleep(0.033)

            print("⚠️  Proceso GStreamer CSI terminó. Reintentando en 3s...")
            time.sleep(3)

        except Exception as e:
            print("⚠️  Error cámara CSI: " + str(e))
            time.sleep(3)

# =============================================================================
# HILO: CÁMARA USB BRAZO (nueva — independiente de la CSI)
# Usa v4l2src con el índice CAMERA_ARM_USB_INDEX (/dev/video1 por defecto).
# Si GStreamer no está disponible intenta leer el archivo directamente
# (modo de compatibilidad mínima).
# =============================================================================

JPEG_TMP_USB = "/tmp/rovssa_frame_usb.jpg"

def video_capture_usb_thread():
    """Captura MJPEG de la cámara USB del brazo mecánico.
    La cámara entrega MJPEG nativo — se usa jpegparse directo, sin conversión."""
    global current_frame_usb

    import os as _os

    device = f"/dev/video{CAMERA_ARM_USB_INDEX}"

    if not GST_AVAILABLE:
        print(f"⚠️  GStreamer no disponible — cámara USB brazo ({device}) deshabilitada")
        return

    CMD = [
        'gst-launch-1.0',
        'v4l2src', f'device={device}', '!',
        'image/jpeg,width=640,height=480,framerate=30/1', '!',
        'jpegparse', '!',
        'multifilesink', f'location={JPEG_TMP_USB}'
    ]

    while True:
        if not _os.path.exists(device):
            print(f"⚠️  Cámara brazo {device} no encontrada. Reintentando en 5s...")
            time.sleep(5)
            continue

        print(f"📷 Iniciando cámara USB brazo ({device}) — MJPEG nativo...")
        try:
            proc = _subprocess.Popen(
                CMD,
                stdout=_subprocess.DEVNULL,
                stderr=_subprocess.PIPE,
            )
            time.sleep(2.0)

            if proc.poll() is not None:
                err = proc.stderr.read().decode('utf-8', errors='ignore')
                print(f"⚠️  GStreamer USB cerró inmediatamente:\n{err}")
                time.sleep(5)
                continue

            print(f"✅ Cámara USB brazo abierta")

            while proc.poll() is None:
                try:
                    if _os.path.exists(JPEG_TMP_USB):
                        with open(JPEG_TMP_USB, 'rb') as f:
                            data = f.read()
                        if data and len(data) > 500:
                            with _frame_usb_lock:
                                current_frame_usb = data
                except Exception:
                    pass
                time.sleep(0.033)

            err = proc.stderr.read().decode('utf-8', errors='ignore')
            print(f"⚠️  GStreamer USB terminó. {err[:200] if err else ''} Reintentando en 5s...")
            time.sleep(5)

        except Exception as e:
            print(f"⚠️  Error cámara USB brazo: {e}")
            time.sleep(5)


    while True:
        # Verificar que el dispositivo existe antes de abrir GStreamer
        if not _os.path.exists(device):
            print(f"⚠️  Cámara brazo {device} no encontrada. Reintentando en 5s...")
            time.sleep(5)
            continue

        print(f"📷 Iniciando cámara USB brazo ({device})...")

        # Intentar primero con JPEG nativo, luego con conversión
        for attempt, cmd in enumerate([CMD, CMD_FALLBACK]):
            try:
                proc = _subprocess.Popen(
                    cmd,
                    stdout=_subprocess.DEVNULL,
                    stderr=_subprocess.DEVNULL,
                )
                time.sleep(2.0)

                if proc.poll() is not None:
                    print(f"⚠️  GStreamer USB (intento {attempt+1}) cerró inmediatamente.")
                    continue

                print(f"✅ Cámara USB brazo abierta (pipeline {attempt+1})")

                while proc.poll() is None:
                    try:
                        if _os.path.exists(JPEG_TMP_USB):
                            with open(JPEG_TMP_USB, 'rb') as f:
                                data = f.read()
                            if data and len(data) > 500:
                                with _frame_usb_lock:
                                    current_frame_usb = data
                    except Exception:
                        pass
                    time.sleep(0.033)

                proc.terminate()
                break  # salir del loop de intentos si el proceso corrió OK

            except Exception as e:
                print(f"⚠️  Error cámara USB brazo (intento {attempt+1}): {e}")

        print("⚠️  Cámara USB brazo: reintentando en 5s...")
        time.sleep(5)


# =============================================================================
# CEREBRO AUTÓNOMO
# =============================================================================

def autonomous_brain_thread():
    estado = "AVANZANDO"
    t_estado = time.time()
    intentos_escape = 0
    dir_escape = "DER"

    print("🧠 Cerebro Autónomo iniciado")

    while True:
        with _mode_lock:
            modo = rover_mode
            parado = estop_active

        if modo != "AUTO" or parado:
            time.sleep(0.1)
            continue

        with _telem_lock:
            df = current_telemetry["distancia_frontal"]
            di = current_telemetry["distancia_izquierda"]
            dd = current_telemetry["distancia_derecha"]

        ahora = time.time()
        delta = ahora - t_estado
        vx = 0.0; omega = 0.0

        if estado == "AVANZANDO":
            vx = 0.6
            if df < OBSTACLE_DIST_M:
                print(f"[AUTO] Obstáculo a {df:.2f}m → FRENANDO")
                estado = "FRENANDO"
                t_estado = ahora
                dir_escape = "DER" if dd >= di else "IZQ"
                intentos_escape = 0

        elif estado == "FRENANDO":
            vx = 0.0
            if delta > 0.5:
                estado = "ESQUIVANDO_" + dir_escape
                t_estado = ahora

        elif estado == "ESQUIVANDO_DER":
            vx = -0.5; omega = 0.7
            if delta > 1.2:
                estado = "MIDIENDO"; t_estado = ahora

        elif estado == "ESQUIVANDO_IZQ":
            vx = -0.5; omega = -0.7
            if delta > 1.2:
                estado = "MIDIENDO"; t_estado = ahora

        elif estado == "GIRANDO_180":
            vx = -0.4; omega = 0.9
            if delta > 3.0:
                estado = "MIDIENDO"; t_estado = ahora

        elif estado == "MIDIENDO":
            vx = 0.0
            if delta > 0.4:
                if df > OBSTACLE_DIST_M * 2:
                    print("[AUTO] Vía libre → AVANZANDO")
                    estado = "AVANZANDO"
                else:
                    intentos_escape += 1
                    if intentos_escape == 1:
                        dir_escape = "IZQ" if dir_escape == "DER" else "DER"
                        estado = "ESQUIVANDO_" + dir_escape
                    else:
                        print("[AUTO] Rincón sin salida → GIRANDO 180°")
                        estado = "GIRANDO_180"
                t_estado = ahora

        send_to_pico({"cmd": "drive", "vx": round(vx, 3), "omega": round(omega, 3)})
        time.sleep(0.05)

# =============================================================================
# FLASK ENDPOINTS
# =============================================================================

# ── SSE: telemetría rover (IMU + ultrasonidos) ────────────────────────────────

def _generate_telemetry():
    while True:
        with _telem_lock:
            data = dict(current_telemetry)
        with _gps_lock:
            data["gps"] = dict(gps_state)
        yield f"data: {json.dumps(data)}\n\n"
        time.sleep(0.1)

@app.route('/telemetry')
def telemetry():
    return Response(_generate_telemetry(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ── SSE: telemetría Pico (encoders + odometría + modo) ───────────────────────

def _generate_pico_telemetry():
    while True:
        with _pico_lock:
            ps = dict(pico_state)
        with _odom_lock:
            od = dict(odometry)

        payload = {
            "arm": {
                "enc_FL": ps["enc"][0],
                "enc_FR": ps["enc"][1],
                "enc_RL": ps["enc"][2],
                "enc_RR": ps["enc"][3],
                "pico_connected": ps["connected"],
            },
            "odom": {
                "x":     round(od["x"], 3),
                "y":     round(od["y"], 3),
                "theta": round(od["theta"], 2),
            },
            "mode": ps["mode"],
            "ch":   ps["ch"],
        }
        yield f"data: {json.dumps(payload)}\n\n"
        time.sleep(0.1)

@app.route('/arm_telemetry')
def arm_telemetry():
    return Response(_generate_pico_telemetry(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ── Video FPV CSI ─────────────────────────────────────────────────────────────

def _generate_frames():
    """MJPEG multipart stream — cámara CSI principal."""
    while True:
        with _frame_lock:
            frame = current_frame

        if frame:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        time.sleep(0.033)

@app.route('/video_feed')
def video_feed():
    return Response(_generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/camera_csi')
def camera_csi():
    """Alias — misma cámara FPV CSI."""
    return Response(_generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

# ── Video USB Brazo ───────────────────────────────────────────────────────────

def _generate_frames_usb():
    """MJPEG multipart stream — cámara USB del brazo mecánico."""
    while True:
        with _frame_usb_lock:
            frame = current_frame_usb

        if frame:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        time.sleep(0.033)

@app.route('/camera_usb')
def camera_usb():
    """Cámara USB del brazo mecánico."""
    return Response(_generate_frames_usb(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

# ── POST /command — recibe comandos del frontend (teclado, gamepad) ───────────

@app.route('/command', methods=['POST'])
def command():
    global rover_mode, estop_active

    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "JSON inválido"}), 400

    cmd = data.get("cmd", "")

    with _mode_lock:
        if estop_active and cmd != "estop_release":
            return jsonify({"status": "ESTOP activo"}), 403

    if cmd == "drive":
        vx    = float(data.get("vx", 0.0))
        omega = float(data.get("omega", 0.0))
        # Solo enviar si estamos en modo MANUAL
        with _mode_lock:
            if rover_mode == "MANUAL":
                send_to_pico({"cmd": "drive", "vx": vx, "omega": omega})
        return jsonify({"status": "ok"})

    elif cmd == "stop":
        send_to_pico({"cmd": "stop"})
        return jsonify({"status": "ok"})

    elif cmd == "estop":
        with _mode_lock:
            estop_active = True
        send_to_pico({"cmd": "stop"})
        print("🛑 E-STOP ACTIVADO")
        return jsonify({"status": "estop"})

    elif cmd == "estop_release":
        with _mode_lock:
            estop_active = False
        print("✅ E-STOP liberado")
        return jsonify({"status": "ok"})

    elif cmd == "set_mode":
        new_mode = data.get("mode", "MANUAL").upper()
        if new_mode in ("MANUAL", "AUTO", "AI"):
            with _mode_lock:
                rover_mode = new_mode
            if new_mode != "MANUAL":
                send_to_pico({"cmd": "stop"})
            print(f"🔄 Modo cambiado a {new_mode}")
            return jsonify({"status": "ok", "mode": new_mode})
        return jsonify({"error": "modo inválido"}), 400

    elif cmd == "reset_odom":
        with _odom_lock:
            odometry["x"] = 0.0
            odometry["y"] = 0.0
            odometry["theta"] = 0.0
        return jsonify({"status": "odometría reseteada"})

    return jsonify({"error": f"comando desconocido: {cmd}"}), 400

# ── Misión autónoma (modo AI) ─────────────────────────────────────────────────

@app.route('/mission', methods=['POST'])
def mission_start():
    """
    Recibe la cola de objetivos desde la laptop y arranca el executor.
    Body: {"objectives": [...]}
    Solo funciona si el rover está en modo AI.
    """
    with _mode_lock:
        if rover_mode != "AI":
            return jsonify({"error": "El rover no está en modo AI"}), 400
        if estop_active:
            return jsonify({"error": "E-STOP activo"}), 403

    try:
        data = request.get_json(force=True)
        objectives = data.get("objectives", [])
        if not objectives:
            return jsonify({"error": "Cola de objetivos vacía"}), 400
    except Exception:
        return jsonify({"error": "JSON inválido"}), 400

    start_mission(objectives)
    print(f"🚀 Misión iniciada con {len(objectives)} objetivos")
    return jsonify({"status": "ok", "objectives_count": len(objectives)})


@app.route('/mission/stop', methods=['POST'])
def mission_stop():
    """E-STOP de misión — detiene el executor en el próximo ciclo."""
    stop_mission()
    send_to_pico({"cmd": "stop"})
    return jsonify({"status": "stopped"})


@app.route('/mission/status', methods=['GET'])
def mission_status():
    """Estado actual de la misión para polling desde el frontend."""
    return jsonify(get_mission_status())

# ── GET /status — resumen general del sistema ─────────────────────────────────

@app.route('/yolo_status')
def yolo_status():
    with _yolo_lock:
        return jsonify({"detections": dict(yolo_detections)})

@app.route('/status')
def status():
    with _pico_lock:
        pc = pico_state["connected"]
    with _mode_lock:
        m = rover_mode
        es = estop_active
    import os as _os
    arm_cam_present = _os.path.exists(f"/dev/video{CAMERA_ARM_USB_INDEX}")
    return jsonify({
        "pico_connected":    pc,
        "i2c_available":     I2C_AVAILABLE,
        "gpio_available":    GPIO_AVAILABLE,
        "cv2_available":     CV2_AVAILABLE,
        "rover_mode":        m,
        "estop":             es,
        "arm_cam_device":    f"/dev/video{CAMERA_ARM_USB_INDEX}",
        "arm_cam_present":   arm_cam_present,
    })

# =============================================================================
# MAIN
# =============================================================================

if __name__ == '__main__':
    print("=" * 60)
    print("  ROVSSA Jetson Server — Modo Hardware")
    print("=" * 60)

    # Inicializar BNO085 en el hilo principal antes de arrancar todo
    _bno_instance = None
    try:
        import board, busio
        from adafruit_bno08x.i2c import BNO08X_I2C
        from adafruit_bno08x import BNO_REPORT_ROTATION_VECTOR as _BNO_RV
        _i2c = busio.I2C(board.SCL, board.SDA)
        _bno_instance = BNO08X_I2C(_i2c, address=BNO085_ADDR)
        _bno_instance.enable_feature(_BNO_RV)
        print("✅ BNO085 pre-inicializado")
    except Exception as e:
        print(f"⚠️  BNO085 no disponible: {e}")

    # Crear interfaz de hardware para el executor autónomo
    _hw_interface = HardwareInterface(
        send_to_pico_fn   = send_to_pico,
        telem_lock        = _telem_lock,
        telemetry_dict    = current_telemetry,
        imu_lock          = _imu_lock,
        imu_refs          = current_telemetry,
        gps_lock          = _gps_lock,
        gps_dict          = gps_state,
        yolo_lock         = _yolo_lock,
        yolo_detections   = yolo_detections,
    )

    threads = [
        threading.Thread(target=serial_reader_thread,     daemon=True, name="SerialRx"),
        threading.Thread(target=serial_writer_thread,     daemon=True, name="SerialTx"),
        threading.Thread(target=lambda: imu_thread(_bno_instance), daemon=True, name="IMU"),
        threading.Thread(target=ultrasonic_thread,        daemon=True, name="Ultrasonic"),
        threading.Thread(target=video_capture_thread,     daemon=True, name="Video-CSI"),
        threading.Thread(target=video_capture_usb_thread, daemon=True, name="Video-USB"),
        threading.Thread(target=autonomous_brain_thread,  daemon=True, name="Brain"),
        threading.Thread(target=lambda: executor_loop(_hw_interface), daemon=True, name="Executor"),
        threading.Thread(
            target=lambda: gps_reader_thread(
                gps_lock=_gps_lock,
                gps_dict=gps_state,
            ),
            daemon=True, name="GPS"
        ),
        threading.Thread(
            target=lambda: yolo_detector_thread(
                frame_lock=_frame_lock,
                get_current_frame=lambda: current_frame,
                yolo_lock=_yolo_lock,
                yolo_detections_dict=yolo_detections,
            ),
            daemon=True, name="YOLO"
        ),
    ]

    for t in threads:
        t.start()
        time.sleep(0.1)

    print("🚀 Servidor ROVSSA en línea — http://0.0.0.0:8000")
    print("   Conectar frontend a http://<IP_JETSON>:8000")
    print("   Ver estado: http://<IP_JETSON>:8000/status")
    print(f"   Cámara CSI:  http://<IP_JETSON>:8000/camera_csi")
    print(f"   Cámara brazo USB: http://<IP_JETSON>:8000/camera_usb  (/dev/video{CAMERA_ARM_USB_INDEX})")
    print("=" * 60)

    app.run(host='0.0.0.0', port=8000, threaded=True, use_reloader=False)