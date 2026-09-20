import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHmac } from 'node:crypto';
import type { FederationPeer } from './mod.readFederationConfig.ts';

export async function probeFederationPeer(peer: FederationPeer, signing: {sender:string;fleet:string;key:string}, signal: AbortSignal) {
  const start = Date.now();
  const row = {url:peer.url,node:peer.node,reachable:false,latency:null as number|null,agents:[] as string[],clock_warning:false,oracle:peer.oracle,resolved_ip:null as string|null,node_unique:false,auth_ok:peer.auth_ok,loopback_self:false,fetch_error:undefined as string|undefined};
  const ip = (address: string) => {
    let value = address.toLowerCase().replace(/^\[|\]$/g,'');
    if (isIP(value) === 6) {
      value = new URL(`http://[${value}]/`).hostname.slice(1,-1);
      const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(value);
      if (mapped) { const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16); return `${high>>8}.${high&255}.${low>>8}.${low&255}`; }
    }
    return value;
  };
  const loopback = (value: string) => value === '::1' || /^127\./.test(value);
  const prohibited = (value: string) => {
    if (isIP(value) === 4) { const [a,b]=value.split('.').map(Number); return a===0 || a>=224 || a===169&&b===254; }
    return value==='::' || /^ff/.test(value) || /^fe[89ab]/.test(value) || /^::/.test(value)&&value!=='::1';
  };
  const url = new URL(peer.url); url.pathname = url.pathname.replace(/\/+$/,'') + '/api/sessions';
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  const explicitLoopback = hostname.toLowerCase()==='localhost' || isIP(hostname)!==0&&loopback(ip(hostname));
  const headers: Record<string,string> = {Accept:'application/json',Connection:'close'};
  const sender = /^([^:\s]+):([^:\s]+)$/.exec(signing.sender);
  if (sender && signing.fleet && signing.key) {
    const from = `${sender[2]}:${sender[1]}`, timestamp = String(Math.floor(Date.now()/1000));
    headers['X-Maw-From']=from; headers['X-Maw-Timestamp']=timestamp; headers['X-Maw-Auth-Version']='v3';
    headers['X-Maw-Signature']=createHmac('sha256',signing.fleet).update(`GET:/api/sessions:${timestamp}`).digest('hex');
    headers['X-Maw-Signature-V3']=createHmac('sha256',signing.key).update(`GET:/api/sessions:${timestamp}::${from}`).digest('hex');
  }
  return new Promise<typeof row>(resolve => {
    let settled=false;
    let request: ReturnType<typeof httpRequest> | undefined;
    const finish = (error?:string) => {
      if (settled) return; settled=true; clearTimeout(timer); signal.removeEventListener('abort',abort);
      if (error) row.fetch_error=error;
      request?.destroy(); resolve(row);
    };
    const abort = () => finish('timeout');
    const timer = setTimeout(()=>finish('timeout'),2500);
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) { abort(); return; }
    void (async()=>{
      try {
        const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await lookup(hostname,{all:true,verbatim:true});
        if (settled) return;
        if (!addresses.length || addresses.some(item=>prohibited(ip(item.address)) || loopback(ip(item.address))&&!explicitLoopback)) { finish('address_not_allowed'); return; }
        const chosen=addresses[0]; row.resolved_ip=ip(chosen.address);
        row.loopback_self=loopback(row.resolved_ip) || Object.values(networkInterfaces()).flat().some(item=>item && ip(item.address)===row.resolved_ip);
        // Resolve once and pin the connection; URL retains hostname for Host/TLS.
        const pinnedLookup = (_host:string, options:unknown, done:Function) => {
          if (options && typeof options==='object' && 'all' in options && options.all) done(null,[chosen]);
          else done(null,chosen.address,chosen.family);
        };
        request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'GET',headers,agent:false,maxHeaderSize:65536,lookup:pinnedLookup as never},response=>{
          row.reachable=true; row.latency=Date.now()-start;
          if ((response.statusCode || 0)<200 || (response.statusCode || 0)>=300) { finish(`http_${response.statusCode || 0}`); return; }
          const chunks: Buffer[]=[];let bytes=0;
          response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)finish('response_too_large');else chunks.push(chunk);});
          response.on('error',()=>finish('network_error'));
          response.on('end',()=>{
            if(settled)return;
            try {
              const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if(!Array.isArray(body))throw new Error();
              row.agents=body.filter(item=>item && typeof item==='object' && typeof item.name==='string').map(item=>item.name); finish();
            } catch { finish('invalid_response'); }
          });
        });
        request.on('error',()=>finish('network_error'));request.end();
      } catch { finish('network_error'); }
    })();
  });
}
