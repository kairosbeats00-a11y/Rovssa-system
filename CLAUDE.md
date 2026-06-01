# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ROVSSA is a ground rover mission control system. It has two parts:
1. **Frontend** (`src/`) — React/TypeScript GCS (Ground Control Station) running in the browser
2. **Backend** (`entorno de simulacion/`) — Python Flask server that runs on a Jetson Nano and interfaces with hardware

## Commands

```bash
# Development
npm run dev        # Start Vite dev server (HMR)
npm run build      # Type-check + production build (tsc -b && vite build)
npm run lint       # ESLint
npm run preview    # Preview production build
```

The backend server runs independently on the Jetson Nano:
```bash
python3 "entorno de simulacion/jetson_server.py"
```

## Architecture

### Frontend (`src/`)

- **`App.tsx`** — Main component. Manages all state and renders the GCS dashboard:
  - SSE connections to Jetson (`/telemetry` at 10 Hz, `/arm_telemetry` at 10 Hz)
  - Sends HTTP commands to `POST /command` (drive, stop, estop, set_mode, reset_odom)
  - Keyboard control loop at 10 Hz (WASD / arrows)
  - Three rover modes: `MANUAL`, `AUTO`, `AI`
  - Jetson IP stored in `localStorage` (key `rovssa_jetson_ip`), configurable via `VITE_JETSON_IP` env var at build time

- **`Missionpanel.tsx`** — Rendered only when mode is `AI`. Block-based mission builder:
  - User assembles mission as a sequence of typed blocks (move + arm categories)
  - `blocksToObjectives()` converts UI blocks → JSON objectives sent to `POST /mission`
  - Polls `GET /mission/status` at 800 ms while mission is running
  - Contains `MapModal` (OSM iframe + Nominatim geocoding) and `JsonModal` sub-components

### Backend (`entorno de simulacion/`)

- **`jetson_server.py`** — Flask server on port 8000. Spawns daemon threads:
  - `SerialRx` / `SerialTx` — USB-CDC to Raspberry Pi Pico (JSON lines at 115200 baud)
  - `IMU` — BNO085 via I2C (quaternion → Euler at 50 Hz)
  - `Ultrasonic` — 3× HC-SR04 via GPIO (BCM pins)
  - `Video-CSI` / `Video-USB` — GStreamer pipelines writing JPEG to `/tmp/`; served as MJPEG multipart streams
  - `Brain` — Autonomous obstacle-avoidance FSM (active in `AUTO` mode)
  - `Executor` — Mission step executor (active in `AI` mode)
  - `GPS` — NEO-M8N NMEA reader
  - `YOLO` — Object detection on CSI frames

- **`mission_executor.py`** — Runs the objective queue for AI mode
- **`hardware_interface.py`** — Abstraction layer passed to the executor (wraps locks + telemetry dicts)
- **`yolo_detector.py`** — Background YOLO inference thread
- **`gps_reader.py`** — NMEA parser thread for NEO-M8N GPS

### Communication protocol

Frontend ↔ Jetson over HTTP (no WebSocket):
| Endpoint | Direction | Description |
|---|---|---|
| `GET /telemetry` | SSE | IMU + ultrasonic + GPS at ~10 Hz |
| `GET /arm_telemetry` | SSE | Pico encoders + odometry + mode |
| `GET /video_feed` | MJPEG | CSI main camera |
| `GET /camera_usb` | MJPEG | USB arm camera |
| `POST /command` | → Jetson | drive / stop / estop / set_mode / reset_odom |
| `POST /mission` | → Jetson | Launch mission (AI mode only) |
| `GET /mission/status` | ← Jetson | Mission polling |
| `POST /mission/stop` | → Jetson | Abort mission |

### Hardware constants (jetson_server.py)
- Pico ports: `/dev/ttyACM0`, `/dev/ttyACM1`, `/dev/ttyUSB0`, `/dev/ttyUSB1`
- Encoder CPR: 13440 (64 CPR × 210:1 gear × 4 quadrature edges)
- Wheel diameter: 0.12 m, wheelbase: 0.35 m
- Obstacle threshold: 0.40 m
- IMU: BNO085 at I2C addr `0x4B`
- Ultrasonic GPIO BCM pins: Front 17/27, Left 22/23, Right 24/10
