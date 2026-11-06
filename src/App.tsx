import { useEffect, useState, useCallback } from 'react';
import Diagnostics from './Diagnostics';
import Connection from './Connection';
import Evidence from './Evidence';
import { apiUrl } from './api';
import RoverMap from './RoverMap';

function getJetsonIP(): string { return window.location.host; }

interface TelemetryData {
  control?: { estop: boolean; epoch: number; session: string };
  simulation?: boolean;
  cameras?: Record<string, boolean>;
  imu_live?: boolean;
  pitch: number;
  roll: number;
  yaw: number;
  distancia_frontal: number;
  distancia_izquierda: number;
  distancia_derecha: number;
  gps?: {
    fix: boolean;
    lat: number;
    lon: number;
    alt: number;
    sats: number;
    speed_ms: number;
  };
}

interface PicoTelemetry {
  arm: {
    enc_FL?: number;
    enc_FR?: number;
    enc_RL?: number;
    enc_RR?: number;
    pico_connected?: boolean;
  };
  odom: { x: number; y: number; theta: number };
  mode: string;
  ch?: number[];
}



function App() {
  const [page,setPage]=useState('Operación');
  const jetsonIP = getJetsonIP();
  const [showSettings, setShowSettings] = useState(false);


  const [telemetry, setTelemetry] = useState<TelemetryData>({
    pitch: 0, roll: 0, yaw: 0,
    distancia_frontal: 0.0,
    distancia_izquierda: 0.0,
    distancia_derecha: 0.0,
  });

  const [picoTelemetry, setPicoTelemetry] = useState<PicoTelemetry>({
    arm: {},
    odom: { x: 0, y: 0, theta: 0 },
    mode: 'GCS',
    ch: [1500, 1500, 1500, 1500, 1500, 1500],
  });

  const [isConnected, setIsConnected]         = useState(false);
  const [isPicoConnected, setIsPicoConnected] = useState(false);

  const [logs, setLogs] = useState<string[]>([
    `[BOOT] ROVSSA Control System iniciado`,
    `[CFG]  Jetson IP: ${getJetsonIP()}`,
  ]);
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;
    let lastSample = 0;
    const staleTimer = setInterval(() => {
      if (lastSample && Date.now() - lastSample > 3000) {
        setIsConnected(false); lastSample = 0;
      }
    }, 750);
    const connect = () => {
      es = new EventSource(apiUrl('/telemetry'));
      es.onopen    = () => { addLog('Rover SSE conectado'); };
      es.onmessage = (e) => { try { const data = JSON.parse(e.data); lastSample = Date.now(); setTelemetry(data); setIsConnected(true); } catch { /* Ignore incomplete SSE messages. */ } };
      es.onerror   = () => { setIsConnected(false); es.close(); retryTimer = setTimeout(connect, 3000); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retryTimer); clearInterval(staleTimer); };
  }, [jetsonIP, addLog]);

  useEffect(() => {
    let es: EventSource;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(apiUrl('/arm_telemetry'));

      es.onmessage = (e) => {
        try {
          const data: PicoTelemetry = JSON.parse(e.data);
          setPicoTelemetry(data);
          setIsPicoConnected(!!data.arm?.pico_connected);
        } catch { /* Ignore incomplete SSE messages. */ }
      };
      es.onerror = () => { setIsPicoConnected(false); es.close(); retryTimer = setTimeout(connect, 3000); };
    };
    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [jetsonIP]);



  const cameras = telemetry.cameras ?? {}
  const gps = isConnected && telemetry.gps?.fix ? telemetry.gps : undefined
  const imu = isConnected && telemetry.imu_live
  const pico = isConnected && isPicoConnected
  const metrics = (items: [string, string][]) => <dl>{items.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  return <main className="station">
    <header className="mast"><div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><h1>ROVSSA</h1><small>Estación de control</small></div></div>
    <div className="actions"><span className={'status '+(isConnected?'live':'')}>{isConnected ? telemetry.simulation?'Simulación':'En línea':'Sin conexión'}</span>
    <button onClick={()=>setShowSettings(true)}>Conexión</button></div></header>
    {showSettings && <Connection close={()=>setShowSettings(false)}/>}
    <nav aria-label="Paneles">{['Operación','Registros','Diagnóstico'].map(tab=><button key={tab} aria-current={page===tab?'page':undefined} onClick={()=>setPage(tab)}>{tab}</button>)}</nav>
    <Evidence online={isConnected} page={page}/>
    <Diagnostics visible={page==='Diagnóstico'} telemetry={isConnected}/>
    {page==='Operación' && <><div className="page-heading"><h2>Transmisión</h2><span>{jetsonIP}</span></div>
    <div className="camera-grid">{(['csi','usb'] as const).map((id,i)=><section className="panel camera" key={id}>
      <div className="section-head"><h3>{i?'Cámara del brazo':'Cámara frontal'}</h3><span className="tag">{id.toUpperCase()}</span></div>
      <div className="feed">{isConnected && cameras[id] ? <Camera id={id}/> : <span>Sin señal de video</span>}</div>
    </section>)}</div>
    <div className="page-heading"><h2>Telemetría</h2><span>{isConnected?'Recepción activa':'Esperando a la Jetson'}</span></div>
    <div className="sensor-grid"><section className="panel"><h3>Posición GPS</h3><p>{gps ? gps.sats+' satélites':'Sin posición válida'}</p>
    {metrics([['Latitud',gps?.lat.toFixed(5)??'—'],['Longitud',gps?.lon.toFixed(5)??'—'],['Altitud',gps?gps.alt.toFixed(1)+' m':'—'],['Velocidad',gps?gps.speed_ms.toFixed(1)+' m/s':'—']])}</section>
    <section className="panel"><h3>Orientación</h3><p>IMU · BNO085</p>{metrics((['pitch','roll','yaw'] as const).map(k=>[k,imu?telemetry[k].toFixed(1)+'°':'—']))}</section>
    <section className="panel"><h3>Proximidad</h3><p>Ultrasonidos · HC-SR04</p>{metrics([['Izquierda',telemetry.distancia_izquierda],['Frente',telemetry.distancia_frontal],['Derecha',telemetry.distancia_derecha]].map(([k,v])=>[String(k),isConnected && !telemetry.simulation && Number(v)>0?Number(v).toFixed(2)+' m':'—']))}</section></div>
    <section className="map"><RoverMap lat={gps?.lat ?? 0} lon={gps?.lon ?? 0} fix={!!gps} yaw={imu?telemetry.yaw:undefined} sats={gps?.sats ?? 0}/></section>
    <div className="lower">
    <section className="panel"><div className="section-head"><h2>Radiocontrol</h2><span className="tag">Pico {pico?'en línea':'sin señal'}</span></div>
    <p>Conducción desde el mando de radio. La estación recibe las lecturas del rover.</p>
    <h3 className="subhead">Encoders</h3>{metrics((['enc_FL','enc_FR','enc_RL','enc_RR'] as const).map(k=>[k.slice(4),pico?String(picoTelemetry.arm[k]??'—'):'—']))}
    <div className="section-head subhead"><h3>Odometría</h3></div>
    {metrics([['X',pico?picoTelemetry.odom.x.toFixed(2)+' m':'—'],['Y',pico?picoTelemetry.odom.y.toFixed(2)+' m':'—'],['Rumbo',pico?picoTelemetry.odom.theta.toFixed(1)+'°':'—']])}
    </section></div><details className="panel"><summary>Registro de la estación</summary>{logs.map((line,i)=><p key={i}>{line}</p>)}</details></>}
  </main>
}

function Camera({id}:{id:string}) {
  const [failed,setFailed]=useState(false)
  return failed?<button onClick={()=>setFailed(false)}>Reintentar video</button>:<img src={apiUrl('/camera_'+id)} alt={id==='usb'?'Vista del brazo':'Vista frontal'} onError={()=>setFailed(true)}/>
}
export default App
