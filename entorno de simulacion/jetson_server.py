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
    # No usar chmod 666; volver a iniciar sesión después de agregar dialout.

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

El frontend se sirve detrás del proxy HTTPS autenticado. Ver SECURITY.md.
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

from diagnostics import note, recent, remember_signals
from safety import SafetyController
from security import install_security

app = Flask(__name__)
install_security(app)
safety = SafetyController()
NETWORK_DRIVE_ENABLED = False
SIMULATION = os.environ.get("ROVSSA_SIMULATION") == "1"

# ── ZMQ + SO101 (con fallbacks seguros) ──────────────────────────────────────

if SIMULATION:
    ZMQ_AVAILABLE = LEROBOT_AVAILABLE = SERIAL_AVAILABLE = False
    I2C_AVAILABLE = GST_AVAILABLE = CV2_AVAILABLE = GPIO_AVAILABLE = False
    _bno_instance = None
else:
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
        I2C_AVAILABLE = True
        note("imu", "✅ BNO085 pre-inicializado")
    except Exception as _e:
        note("imu", f"⚠️  BNO085 no disponible: {_e}")

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
from datetime import datetime, timezone
import base64
import signal
import sqlite3
import uuid
import event_store
import identity
from gps_reader import gps_reader_thread

# =============================================================================
# CONFIGURACIÓN — Ajustar según hardware real
# =============================================================================

# Puerto serial del Pico (USB CDC)
PICO_PORTS = ["/dev/ttyACM1", "/dev/ttyACM2", "/dev/ttyUSB0", "/dev/ttyUSB1"]
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
CAMERA_ARM_USB_INDEX = int(os.environ.get("ROVSSA_USB_INDEX", "1"))   # → /dev/video1

# Odometría — ajustar según tu rover real
WHEEL_DIAMETER_M  = 0.12    # diámetro rueda en metros (medir con regla)
WHEELBASE_M       = 0.35    # distancia entre ruedas izq y der
ENCODER_CPR       = 13440   # del firmware: 64 CPR × 210:1 × 4 flancos
WHEEL_CIRCUMFERENCE = math.pi * WHEEL_DIAMETER_M
DIST_PER_TICK     = WHEEL_CIRCUMFERENCE / ENCODER_CPR

# Umbral de obstáculo para cerebro autónomo (metros)
OBSTACLE_DIST_M = 0.40    # frenar si hay algo a menos de 40 cm

# SO101 / ZMQ
SO101_PORT   = "/dev/ttyACM0"   # SO101 follower (Pico suele quedar en ACM1)
ZMQ_CMD_PORT = 5555
ZMQ_OBS_PORT = 5556

# =============================================================================
# ESTADO COMPARTIDO (protegido por locks)
# =============================================================================

_telem_lock = threading.Lock()
current_telemetry = {
    "pitch": 0.0,
    "roll":  0.0,
    "yaw":   0.0,
    "distancia_frontal":   0.0,
    "distancia_izquierda": 0.0,
    "distancia_derecha":   0.0,
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

# ── Estado GPS (se puebla cuando se integre el M8N) ──────────────────────────
_gps_lock = threading.Lock()
gps_state = {"fix": False, "lat": 0.0, "lon": 0.0, "alt": 0.0, "sats": 0, "speed_ms": 0.0}

# ── Detecciones YOLO (se puebla cuando se integre la inferencia) ──────────────
_yolo_lock = threading.Lock()
yolo_detections = {}   # {"bottle": {"cx": 320, "cy": 240, "area": 5000}, ...}
# =============================================================================
# CORS
# =============================================================================

# =============================================================================
# HILO: LECTOR SERIAL DEL PICO
# Recibe JSON lines: {"enc":[FL,FR,RL,RR],"mode":"RC","ch":[...]}
# =============================================================================

def find_pico_port():
    """Busca el puerto serial del Pico automáticamente."""
    configured = os.environ.get("ROVSSA_PICO_PORT")
    if configured:
        return configured if os.path.exists(configured) else None
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
            note("pico", "⚠️  Pico no encontrado. Reintentando en 3s...")
            with _pico_lock:
                pico_state["connected"] = False
            time.sleep(3)
            continue

        try:
            ser = serial.Serial(port, PICO_BAUD, timeout=1.0)
            note("pico", f"✅ Pico conectado en {port}")
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
                        enc = msg.get("enc") if isinstance(msg, dict) else None
                        if not isinstance(enc, list) or len(enc) != 4 or any(type(v) is not int for v in enc):
                            continue
                        mode = msg.get("mode")
                        ch = msg.get("ch")

                        with _pico_lock:
                            pico_state["updated_at"] = time.monotonic()
                            pico_state["enc"]  = enc
                            pico_state["mode"] = mode
                            pico_state["ch"]   = ch

                        # Actualizar odometría
                        _update_odometry(enc)

                    except (json.JSONDecodeError, KeyError):
                        pass  # línea de debug del Pico ("Pico listo.", etc.)

        except serial.SerialException as e:
            note("pico", f"❌ Error serial Pico: {e}. Reintentando en 3s...")
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
    """Bounded writes through the shared interlock; never replay a command queue."""
    ser = None
    while True:
        try:
            if ser is None or not ser.is_open:
                port = find_pico_port() if SERIAL_AVAILABLE else None
                if not port:
                    safety.trip("Pico disconnected")
                    time.sleep(0.2)
                    continue
                ser = serial.Serial(port, PICO_BAUD, timeout=0.2, write_timeout=0.2)
                safety.trip("serial reconnected: rearm required")
            safety.dispatch(lambda cmd: ser.write((json.dumps(cmd)+"\n").encode("utf-8")))
        except Exception:
            safety.trip("serial write failed")
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass
            ser = None
        time.sleep(0.05)


def send_to_pico(cmd: dict):
    safety.submit(cmd)


def watchdog_thread():
    while True:
        safety.tick()
        time.sleep(0.05)

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
        note("imu", "⚠️  BNO085 no inicializado — IMU deshabilitada")
        return
    
    note("imu", "✅ BNO085 listo")

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
            roll = _math.degrees(_math.atan2(sinr_cosp, cosr_cosp))

            sinp = 2.0 * (real * j - k * i)
            sinp = max(-1.0, min(1.0, sinp))
            pitch = _math.degrees(_math.asin(sinp))

            siny_cosp = 2.0 * (real * k + i * j)
            cosy_cosp = 1.0 - 2.0 * (j * j + k * k)
            yaw = _math.degrees(_math.atan2(siny_cosp, cosy_cosp))

            with _imu_lock:
                _imu_pitch = pitch
                _imu_roll  = roll
                _imu_yaw   = yaw

            with _telem_lock:
                current_telemetry["imu_updated"] = time.monotonic()
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
        note("sonar", "✅ GPIO ultrasonidos configurado")
        return True
    except Exception as e:
        note("sonar", f"⚠️  Error configurando GPIO: {e}")
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
                return 0.0   # unknown: fail closed
        pulse_start = time.time()

        # Esperar fin del eco
        while GPIO.input(echo_pin) == 1:
            if time.time() - pulse_start > timeout_s:
                return 0.0
        pulse_end = time.time()

        # Convertir a cm (velocidad sonido ≈ 34300 cm/s, ida y vuelta / 2)
        dist_cm = (pulse_end - pulse_start) * 34300 / 2.0
        return min(max(dist_cm, 2.0), 500.0)   # clamp 2..500 cm

    except Exception:
        return 0.0

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
                current_telemetry[key + "_updated"] = time.monotonic()
            time.sleep(0.015)   # 15 ms entre disparos para evitar interferencia

        time.sleep(0.005)

# =============================================================================
# HILO: CÁMARA FPV CSI (principal — sin tocar)
# =============================================================================

def _parse_jpeg_frames(pipe_stdout):
    """
    Lee bytes del stdout de gst-launch y los corta en frames JPEG completos.
    JPEG: empieza con FF D8, termina con FF D9.
    Generador — hace yield de bytes de cada frame completo.
    """
    buf = b""
    CHUNK = 65536  # 64 KB por lectura

    while True:
        chunk = pipe_stdout.read1(CHUNK)
        if not chunk:
            break
        buf += chunk

        # Buscar y emitir todos los JPEGs completos que haya en el buffer
        while True:
            start = buf.find(b"\xff\xd8")
            if start == -1:
                buf = buf[-1:]     # SOI may straddle two chunks
                break
            end = buf.find(b"\xff\xd9", start + 2)
            if end == -1:
                buf = buf[start:] if len(buf) - start < 4000000 else b""
                break
            # Frame completo [start : end+2]
            yield buf[start : end + 2]
            buf = buf[end + 2:]

# One reader per camera owns its GStreamer process. Both preview and evidence
# consume the same complete JPEG, stamped when it reaches the Jetson.
frames = {}
frames_lock = threading.Lock()

def capture_camera(name, pipeline):
    if not GST_AVAILABLE:
        note(name, 'GStreamer no disponible')
        return
    command = ['gst-launch-1.0', '-q', *pipeline, '!', 'fdsink', 'fd=1']
    while True:
        try:
            with _subprocess.Popen(command, stdout=_subprocess.PIPE) as process:
                for jpeg in _parse_jpeg_frames(process.stdout):
                    with frames_lock:
                        frames[name] = (time.monotonic(), datetime.now(timezone.utc).isoformat(), jpeg)
                note(name, f"GStreamer terminó con código {process.wait()}")
        except OSError as exc:
            note(name, str(exc))
        time.sleep(3)


def video_capture_thread():
    capture_camera('csi', ['nvarguscamerasrc', '!',
        'video/x-raw(memory:NVMM),width=640,height=480,framerate=15/1', '!',
        'nvvidconv', '!', 'video/x-raw,format=I420', '!', 'jpegenc', 'quality=65'])


def video_capture_usb_thread():
    capture_camera('usb', ['v4l2src', f'device=/dev/video{CAMERA_ARM_USB_INDEX}', '!',
        'image/jpeg,width=640,height=480,framerate=30/1', '!', 'jpegparse'])


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
# HILO: TELEOPERACIÓN BRAZO SO101 VÍA ZMQ
# =============================================================================

_robot_lock = threading.Lock()

def zmq_arm_thread(robot):
    """Disabled until authenticated transport and physical interlocks are validated."""
    return

# =============================================================================
# FLASK ENDPOINTS
# =============================================================================

# ── SSE: telemetría rover (IMU + ultrasonidos) ────────────────────────────────

def sensor_snapshot():
    with _telem_lock:
        data = dict(current_telemetry)
    for key in ("distancia_frontal", "distancia_izquierda", "distancia_derecha"):
        if time.monotonic() - data.pop(key + "_updated", float("-inf")) >= 2:
            data[key] = 0
    data["imu_live"] = time.monotonic() - data.pop("imu_updated", float("-inf")) < 2
    with _gps_lock:
        data["gps"] = dict(gps_state)
    if time.monotonic() - data["gps"].pop("updated_at", float("-inf")) > 3:
        data["gps"]["fix"] = False
    return data


def _generate_telemetry():
    while True:
        data = sensor_snapshot()
        data["control"] = safety.snapshot()
        data["simulation"] = SIMULATION
        with frames_lock:
            data["cameras"] = {k: time.monotonic() - v[0] < 2 for k, v in frames.items()}
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
                "pico_connected": ps["connected"] and time.monotonic() - ps.get("updated_at", float("-inf")) < 3,
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

def stream_camera(name):
    def generate():
        last = None
        while True:
            with frames_lock:
                frame = frames.get(name)
            if frame and frame[0] != last and time.monotonic() - frame[0] < 2:
                last = frame[0]
                yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame[2] + b'\r\n'
            time.sleep(0.033)
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/video_feed')
@app.route('/camera_csi')
def camera_csi():
    return stream_camera('csi')


@app.route('/camera_usb')
def camera_usb():
    return stream_camera('usb')


def record_event(event_id, trigger):
    data = sensor_snapshot()
    with frames_lock:
        available = dict(frames)
    images = {}
    for name in ("csi", "usb"):
        frame = available.get(name)
        images[name] = None
        if frame and time.monotonic() - frame[0] < 2:
            images[name] = {"received_at": frame[1], "jpeg_base64": base64.b64encode(frame[2]).decode("ascii")}
    with _pico_lock:
        pico = dict(pico_state)
    with _odom_lock:
        odom = dict(odometry)
    pico_live = pico["connected"] and time.monotonic() - pico.get("updated_at", float("-inf")) < 3
    return event_store.save({
        "schema": "rovssa.event.v2", "id": event_id, "trigger": trigger,
        "station": os.environ["ROVSSA_ORIGIN"], "simulation": SIMULATION,
        "observed_at": datetime.now(timezone.utc).isoformat(), "cameras": images,
        "gps": data["gps"] if data["gps"]["fix"] else None,
        "imu_degrees": {k: data[k] for k in ("pitch", "roll", "yaw")} if data["imu_live"] else None,
        "proximity_m": {k: data["distancia_" + k] or None for k in ("frontal", "izquierda", "derecha")},
        "pico": {"encoders": dict(zip(("FL","FR","RL","RR"), pico["enc"])),
                 "odometry": odom, "mode": pico["mode"], "rc_channels": pico["ch"]} if pico_live else None,
    })


@app.errorhandler(sqlite3.Error)
def storage_failure(exc):
    app.logger.error("Event storage: %s", exc)
    return jsonify(error="Error de almacenamiento en la Jetson. Revisá el espacio y los permisos."), 503


@app.route('/events', methods=['GET','POST'])
def events():
    if request.method == 'GET':
        return jsonify(event_store.list_events())
    body = request.get_json(silent=True)
    try:
        event_id = str(uuid.UUID(body["id"]))
    except (TypeError, ValueError, KeyError, AttributeError):
        return jsonify(error="Identificador de evento inválido"), 400
    return jsonify(record_event(event_id, "station"))


@app.get('/diagnostics')
def diagnostics():
    data = sensor_snapshot()
    now = time.monotonic()
    with frames_lock:
        signals = {k: k in frames and now - frames[k][0] < 2 for k in ("csi","usb")}
    with _pico_lock:
        signals["pico"] = pico_state["connected"] and now - pico_state.get("updated_at", float("-inf")) < 3
    signals.update(imu=data["imu_live"], gps=data["gps"]["fix"])
    for name in ("frontal","izquierda","derecha"):
        signals[name] = data["distancia_" + name] > 0
    remember_signals(signals, SIMULATION)
    return jsonify(signals=signals, logs=recent(), simulation=SIMULATION)


@app.get('/identity')
def capture_identity():
    return jsonify(public_key=identity.public_key())


@app.get('/events/<uuid:event_id>')
def event_file(event_id):
    content = event_store.read(str(event_id))
    if content is None:
        return jsonify(error="Evento desconocido"), 404
    return Response(content, mimetype="application/json")


def enable_local_capture():
    # A local RC/GPIO adapter can signal the server even when the router is down.
    triggers = queue.SimpleQueue()
    def worker():
        while True:
            triggers.get()
            try:
                record_event(str(uuid.uuid4()), "local")
            except Exception:
                app.logger.exception("No se pudo guardar el evento local")
    signal.signal(signal.SIGUSR1, lambda *_: triggers.put(True))
    threading.Thread(target=worker, daemon=True).start()


@app.post('/observations/<camera>')
def observation(camera):
    if camera not in ('usb', 'csi'):
        return jsonify(error="Cámara desconocida"), 404
    with frames_lock:
        frame = frames.get(camera)
    if not SIMULATION and (not frame or time.monotonic() - frame[0] >= 2):
        return jsonify(error="La cámara no tiene una imagen reciente"), 409
    data = sensor_snapshot()
    return jsonify(schema="rovssa.observation.v1", simulation=SIMULATION,
                   station=os.environ["ROVSSA_ORIGIN"], camera=camera,
                   observed_at=datetime.now(timezone.utc).isoformat(),
                   frame_received_at=frame[1] if frame else None,
                   jpeg_base64=base64.b64encode(frame[2]).decode("ascii") if frame else None,
                   gps=data["gps"] if data["gps"]["fix"] else None,
                   imu={k: data[k] for k in ("pitch","roll","yaw")} if data["imu_live"] else None)


# ── POST /command — recibe comandos del frontend (teclado, gamepad) ───────────

@app.route('/heartbeat', methods=['POST'])
def heartbeat():
    return jsonify(safety.heartbeat())


@app.route('/command', methods=['POST'])
def command():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("cmd"), str):
        return jsonify(error="JSON object with cmd required"), 400
    cmd = data["cmd"]
    if not NETWORK_DRIVE_ENABLED:
        return jsonify(error="Conducción por radiocontrol; órdenes de red desactivadas"), 409
    if cmd in ("drive", "estop_release") and data.get("session") != safety.session:
        return jsonify(error="Stale server session; refresh control status"), 409
    try:
        if cmd in ("stop", "estop"):
            safety.trip("operator stop")
            stop_mission()
        elif cmd == "estop_release":
            safety.rearm(data.get("epoch"))
        elif cmd == "drive":
            safety.drive(data.get("vx"), data.get("omega"), data.get("epoch"), data.get("sequence"))
        elif cmd == "set_mode":
            if data.get("mode") != "MANUAL":
                return jsonify(error="Autonomous modes are disabled pending validation"), 409
            safety.trip("mode change: rearm required")
            stop_mission()
        elif cmd == "reset_odom":
            with _odom_lock:
                odometry.update(x=0.0, y=0.0, theta=0.0)
        else:
            return jsonify(error="Unknown command"), 400
    except ValueError as exc:
        return jsonify(error=str(exc)), 409 if cmd == "estop_release" else 400
    return jsonify(status="ok", **safety.snapshot())


@app.route('/mission', methods=['POST'])
def mission_start():
    return jsonify(error="Experimental missions disabled pending safety validation"), 409


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
        "estop":             safety.snapshot()["estop"],
        "control":           safety.snapshot(),
        "simulation":        SIMULATION,
        "autonomy_enabled":  False,
        "zmq_enabled":       False,
        "arm_cam_device":    f"/dev/video{CAMERA_ARM_USB_INDEX}",
        "arm_cam_present":   arm_cam_present,
    })

# =============================================================================
# MAIN
# =============================================================================

if __name__ == '__main__':
    if SIMULATION:
        threads = []
        print("SIMULATION: no hardware threads or actuators initialized")
    else:
        threads = [
            threading.Thread(target=serial_reader_thread, daemon=True),

            threading.Thread(target=lambda: imu_thread(_bno_instance), daemon=True),
            threading.Thread(target=ultrasonic_thread, daemon=True),
            threading.Thread(target=video_capture_thread, daemon=True),
            threading.Thread(target=video_capture_usb_thread, daemon=True),
            threading.Thread(target=lambda: gps_reader_thread(_gps_lock, gps_state), daemon=True),
        ]
    if hasattr(signal, "SIGUSR1"):
        enable_local_capture()
    if NETWORK_DRIVE_ENABLED and not SIMULATION:
        threads.append(threading.Thread(target=serial_writer_thread, daemon=True))
        threads.append(threading.Thread(target=watchdog_thread, daemon=True))
    for thread in threads:
        thread.start()
    print("ROVSSA backend: loopback only, access through authenticated HTTPS proxy")
    app.run(host='127.0.0.1', port=8000, threaded=True, use_reloader=False, debug=False)
