import { computeAddress, recoverAddress, sha256, Signature, toUtf8Bytes } from 'ethers'

export type Snapshot = {
  schema:string; observed_at?:string; simulation?:boolean; station?:string; trigger?:string
  camera?:string; jpeg_base64?:string; cameras?:Record<string,{jpeg_base64:string}|null>
  gps?:{lat:number;lon:number;alt?:number;sats?:number;speed_ms?:number}
  imu?:Record<string,number>; imu_degrees?:Record<string,number>; proximity_m?:Record<string,number>
  pico?:{encoders?:Record<string,number>;odometry?:Record<string,number>;mode?:string;rc_channels?:number[]}
}
export type Capture = {file:Blob; data:Snapshot; fileHash:string; digest:string; rawSignature:string|null}

export async function parseCapture(file:Blob):Promise<Capture> {
  if(file.size>16000000) throw Error('El archivo supera el tamaño máximo.')
  const bytes=new Uint8Array(await file.arrayBuffer())
  const outer=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  const fileHash=sha256(bytes)
  if(outer?.schema==='rovssa.signed.v1') {
    if(typeof outer.payload!=='string' || typeof outer.signature!=='string' ||
      Object.keys(outer).length!==3) throw Error('Formato de firma inválido.')
    const data=JSON.parse(outer.payload)
    if(data?.schema!=='rovssa.event.v2') throw Error('Contenido firmado desconocido.')
    return {file,data,fileHash,digest:sha256(toUtf8Bytes(outer.payload)),rawSignature:outer.signature}
  }
  if(!['rovssa.event.v2','rovssa.observation.v1'].includes(outer?.schema)) throw Error('Elegí un JSON de ROVSSA.')
  return {file,data:outer,fileHash,digest:fileHash,rawSignature:null}
}

export function captureProof(record:Capture, trusted:string) {
  if(record.rawSignature===null) return {label:'Registro anterior sin firma de origen'}
  if(!trusted) return {label:'Identidad del rover pendiente de obtener'}
  const raw=record.rawSignature
  if(/^[\da-f]{128}$/.test(raw)) {
    for(const yParity of [0,1] as const) {
      try {
        const signature=Signature.from({r:'0x'+raw.slice(0,64),s:'0x'+raw.slice(64),yParity})
        if(recoverAddress(record.digest,signature)===computeAddress(trusted)) {
          return {label:'Firma válida del rover',signature:signature.serialized}
        }
      } catch { /* Malformed scalar or incompatible recovery parity. */ }
    }
  }
  return {label:'Firma inválida para este rover'}
}

