import {useEffect,useState} from 'react'
import {apiFetch} from './api'

type Row={time:string;message:string}
type Report={signals:Record<string,boolean>;logs:Record<string,Row[]>;simulation:boolean}
const names:Record<string,string>={station:'Estación de control',link:'Enlace con la Jetson',jetson:'Computadora central',csi:'Cámara frontal',usb:'Cámara del brazo',gps:'GPS',imu:'IMU',frontal:'Distancia frontal',izquierda:'Distancia izquierda',derecha:'Distancia derecha',pico:'Pico / encoders'}
export default function Diagnostics({visible,telemetry}:{visible:boolean;telemetry:boolean}) {
  const [report,setReport]=useState<Report>()
  const [reachable,setReachable]=useState<boolean|null>(null)
  const [last,setLast]=useState('')
  const [local,setLocal]=useState<Row[]>([])
  const [node,setNode]=useState('link')
  useEffect(()=>{
    let active=true
    let previous=''
    let timer:ReturnType<typeof setTimeout>
    const poll=async()=>{
      const time=new Date().toISOString()
      let message=''
      try {
        const data:Report=await (await apiFetch('/diagnostics',{signal:AbortSignal.timeout(4000)})).json()
        if(!active)return
        setReport(data);setReachable(true);setLast(time);message='La API de diagnóstico respondió.'
      } catch(error) {
        if(!active)return
        setReachable(false);message='Sin respuesta válida de la API: '+String(error)
      }
      if(previous!==message){setLocal(rows=>[...rows.slice(-39),{time,message}]);previous=message}
      timer=setTimeout(poll,4000)
    }
    void poll();return ()=>{active=false;clearTimeout(timer)}
  },[])
  if(!visible)return null
  const sensors=Object.keys(names).slice(3)
  function status(id:string) {
    if(id==='station')return 'Activa'
    if(id==='link')return reachable===null?'Consultando':reachable?(location.protocol==='https:'?'HTTPS activo':'Enlace local activo'):'Sin respuesta'
    if(!reachable)return 'Desconocido'
    if(id==='jetson')return telemetry?'Telemetría activa':'API activa · telemetría pendiente'
    if(report?.simulation)return 'Simulación'
    return report?.signals[id]?'Lectura vigente':'Sin lectura vigente'
  }
  function button(id:string) {
    return <button key={id} aria-pressed={node===id} data-state={status(id)} className="node" onClick={()=>setNode(id)}><strong>{names[id]}</strong><small>{status(id)}</small></button>
  }
  const rows=node==='link'||node==='station'?local:[...(report?.logs[node]??[]),...(['frontal','izquierda','derecha'].includes(node)?report?.logs.sonar??[]:[])].sort((a,b)=>a.time.localeCompare(b.time))
  return <section className="panel"><div className="section-head"><h2>Diagnóstico del rover</h2><small>Última respuesta: {last?new Date(last).toLocaleTimeString():'pendiente'}</small></div>
    <div className="signal-path">{button('station')}<span>→</span>{button('link')}<span>→</span>{button('jetson')}</div>
    <div className="sensor-nodes">{sensors.map(button)}</div>
    <div className="log-view"><h3>{names[node]} · {status(node)}</h3>
    {!reachable && report && <p>Se muestran los últimos mensajes recibidos.</p>}
    {rows.length?<ol>{rows.slice().reverse().map((r,i)=><li key={i}><time>{new Date(r.time).toLocaleTimeString()}</time> {r.message}</li>)}</ol>:<p>Sin mensajes de este componente en el historial reciente.</p>}</div>
  </section>
}
