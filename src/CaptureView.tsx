import RoverMap from './RoverMap'
import type {Snapshot} from './captureProof'

const number=(v:unknown,unit='',digits=1)=>typeof v==='number' && Number.isFinite(v)?v.toFixed(digits)+unit:'—'
export default function CaptureView({data}:{data:Snapshot}) {
  const gps=data.gps
  const position=gps && Number.isFinite(gps.lat) && Math.abs(gps.lat)<=90 && Number.isFinite(gps.lon) && Math.abs(gps.lon)<=180
  const imu=data.imu_degrees ?? data.imu
  function metrics(title:string, values:[string,string][]) {
    return <section className="panel"><h3>{title}</h3><dl>{values.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
  }
  return <article className="snapshot"><div className="section-head"><h2>Captura del {typeof data.observed_at==='string'?new Date(data.observed_at).toLocaleString():'momento desconocido'}</h2><span className="tag">{data.simulation===true?'Simulación':'Archivo'}</span></div>
  <div className="camera-grid">{[['csi','Frontal'],['usb','Brazo']].map(([id,label])=>{
    const jpeg=data.cameras?.[id]?.jpeg_base64 ?? (data.camera===id?data.jpeg_base64:undefined)
    return <section key={id} className="panel camera"><h3 className="section-head">{label}</h3><div className="feed">{typeof jpeg==='string'?<img alt={'Captura '+label} src={'data:image/jpeg;base64,'+jpeg}/>:<span>Sin imagen registrada</span>}</div></section>
  })}</div><div className="sensor-grid">
  {metrics('GPS',[['Latitud',number(gps?.lat,'°',5)],['Longitud',number(gps?.lon,'°',5)],['Altitud',number(gps?.alt,' m')],['Velocidad',number(gps?.speed_ms,' m/s')],['Satélites',number(gps?.sats,'',0)]])}
  {metrics('Orientación',['pitch','roll','yaw'].map(k=>[k,number(imu?.[k],'°')]))}
  {metrics('Proximidad',['izquierda','frontal','derecha'].map(k=>[k,number(data.proximity_m?.[k],' m',2)]))}
  {metrics('Encoders',['FL','FR','RL','RR'].map(k=>[k,number(data.pico?.encoders?.[k],'',0)]))}
  {metrics('Odometría',['x','y','theta'].map(k=>[k,number(data.pico?.odometry?.[k],k==='theta'?'°':' m')]))}
  {metrics('Radiocontrol',[['Modo',typeof data.pico?.mode==='string'?data.pico.mode:'—'],...(Array.isArray(data.pico?.rc_channels)?data.pico.rc_channels.slice(0,16).map((v,i):[string,string]=>['Canal '+(i+1),number(v,'',0)]):[])])}</div>
  {position && <div className="map"><RoverMap lat={gps.lat} lon={gps.lon} sats={Number.isFinite(gps.sats)?gps.sats:0} fix yaw={Number.isFinite(imu?.yaw)?imu?.yaw:undefined}/></div>}</article>
}
