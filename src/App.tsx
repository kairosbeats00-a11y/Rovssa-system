import { useEffect, useState } from 'react';

// IP del servidor Python (Asegúrate de que sea la IP de tu Jetson)
const JETSON_IP = "127.0.0.1";

interface TelemetryData {
  pitch: number;
  roll: number;
  yaw: number;
  distancia_frontal: number;
  distancia_izquierda: number;
  distancia_derecha: number;
}

function App() {
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    pitch: 0,
    roll: 0,
    yaw: 0,
    distancia_frontal: 5.0,
    distancia_izquierda: 5.0,
    distancia_derecha: 5.0
  });
  
  const [isConnected, setIsConnected] = useState(false);
  const [roverMode, setRoverMode] = useState<'MANUAL' | 'AUTO' | 'AI'>('AUTO');
  const [isEStopActive, setIsEStopActive] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(`http://${JETSON_IP}:8000/telemetry`);

    eventSource.onopen = () => setIsConnected(true);

    eventSource.onmessage = (event) => {
      try {
        const data: TelemetryData = JSON.parse(event.data);
        setTelemetry(data);
      } catch (err) {
        console.error("Error leyendo telemetría:", err);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      eventSource.close();
    };

    return () => eventSource.close();
  }, []);

  const handleEStop = () => {
    setIsEStopActive(!isEStopActive);
  };

  const distFrontal = telemetry?.distancia_frontal ?? 5.0;
  const distancePercentage = Math.min((distFrontal / 5.0) * 100, 100);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-mono p-4 selection:bg-green-900 selection:text-green-400">
      
      <header className="flex justify-between items-end border-b border-slate-800 pb-4 mb-4">
        <div>
          <h1 className="text-2xl font-black tracking-tighter text-white">
            ROVSA <span className="text-green-500">//</span> MISSION CONTROL
          </h1>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-1">
            IAA 2026 • Enlace Local
          </p>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Estado del Sistema</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
              <span className={`text-xs font-bold tracking-widest ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
                {isConnected ? 'EN LÍNEA' : 'SIN SEÑAL'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="grid grid-cols-12 gap-4 h-[85vh]">
        
        <section className="col-span-8 bg-black rounded-lg border border-slate-800 overflow-hidden relative flex flex-col">
          <div className="absolute top-4 left-4 z-10 bg-black/60 px-2 py-1 rounded text-[10px] text-green-500 border border-green-900 uppercase tracking-widest backdrop-blur-sm">
            Cam-01 / Feed Principal
          </div>
          <img 
            src={`http://${JETSON_IP}:8000/video_feed`} 
            alt="Rover Main Camera"
            className={`w-full h-full object-cover ${isEStopActive ? 'grayscale' : ''}`}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </section>

        <aside className="col-span-4 flex flex-col gap-4">
          
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Control de Operaciones</h3>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {['MANUAL', 'AUTO', 'AI'].map((mode) => (
                <button 
                  key={mode}
                  onClick={() => setRoverMode(mode as any)}
                  className={`py-2 text-[10px] font-bold rounded uppercase tracking-wider transition-colors ${
                    roverMode === mode 
                      ? 'bg-green-900/50 text-green-400 border border-green-700' 
                      : 'bg-slate-950 text-slate-500 border border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button 
              onClick={handleEStop}
              className={`w-full py-3 rounded text-sm font-black uppercase tracking-widest transition-all ${
                isEStopActive ? 'bg-red-600 text-white animate-pulse' : 'bg-red-950/50 text-red-500 border border-red-900'
              }`}
            >
              {isEStopActive ? 'SISTEMA DETENIDO' : 'PARADA DE EMERGENCIA'}
            </button>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Unidad Inercial (IMU)</h3>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">PITCH</div>
                <div className="font-bold text-slate-200">{(telemetry?.pitch ?? 0).toFixed(1)}°</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">ROLL</div>
                <div className="font-bold text-slate-200">{(telemetry?.roll ?? 0).toFixed(1)}°</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">YAW</div>
                <div className="font-bold text-slate-200">{(telemetry?.yaw ?? 0).toFixed(1)}°</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Radar Perimetral</h3>
            <div className="grid grid-cols-3 gap-2 text-center mb-4">
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">IZQ</div>
                <div className="font-bold text-slate-200">{(telemetry?.distancia_izquierda ?? 0).toFixed(1)}m</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">FRONT</div>
                <div className="font-bold text-slate-200">{(telemetry?.distancia_frontal ?? 0).toFixed(1)}m</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 p-2 rounded">
                <div className="text-[9px] text-slate-500 mb-1">DER</div>
                <div className="font-bold text-slate-200">{(telemetry?.distancia_derecha ?? 0).toFixed(1)}m</div>
              </div>
            </div>
            <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden border border-slate-800">
              <div 
                className={`h-full transition-all duration-300 ${distFrontal < 1.0 ? 'bg-red-500' : distFrontal < 2.5 ? 'bg-yellow-400' : 'bg-green-500'}`}
                style={{ width: `${distancePercentage}%` }}
              ></div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex-1 overflow-hidden flex flex-col">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Terminal de Sistema</h3>
            <div className="text-[10px] leading-tight font-mono space-y-2 flex-1 overflow-y-auto">
              <p className="text-slate-500">[{new Date().toLocaleTimeString()}] Sistema de navegación operativo.</p>
              {isConnected && <p className="text-blue-400">[{new Date().toLocaleTimeString()}] Enlace WebSocket 8000 activo.</p>}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;