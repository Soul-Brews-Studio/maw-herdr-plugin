import { readFederationConfig } from './mod.readFederationConfig.ts';
import { probeFederationPeer } from './mod.probeFederationPeer.ts';

export function createFederation(shutdown: AbortSignal) {
  type Payload = {local_url:string; peers:Awaited<ReturnType<typeof probeFederationPeer>>[]; totalPeers:number; reachablePeers:number};
  let cache: {key:string;expires:number;value:Payload}|undefined;
  let flight: {key:string;promise:Promise<Payload>}|undefined;
  const wait = (promise:Promise<Payload>,signal:AbortSignal) => new Promise<Payload>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('request aborted'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
  return {
    async close() { if(flight)await flight.promise; },
    namedPeers() { return readFederationConfig(false).peers.map(peer=>({name:peer.name,url:peer.url})); },
    async status(signal:AbortSignal) {
      if(signal.aborted)throw new Error('request aborted');
      const config=readFederationConfig();
      if(cache?.key===config.fingerprint && cache.expires>Date.now())return cache.value;
      while(flight && flight.key!==config.fingerprint) await wait(flight.promise,signal);
      if(!flight) {
        const promise=(async()=>{
          const deadline=new AbortController();
          const timer=setTimeout(()=>deadline.abort(),10000);
          const sweep=AbortSignal.any([shutdown,deadline.signal]);
          const rows: Payload['peers']=new Array(config.peers.length);
          let next=0;
          try { await Promise.all(Array.from({length:Math.min(4,config.peers.length)},async()=>{
            while(next<config.peers.length) {const index=next++;rows[index]=await probeFederationPeer(config.peers[index],config,sweep);}
          })); } finally {clearTimeout(timer);}
          const counts=new Map<string,number>();for(const peer of config.peers)if(peer.node)counts.set(peer.node,(counts.get(peer.node)||0)+1);
          for(const row of rows)row.node_unique=!!row.node&&counts.get(row.node)===1;
          const value={local_url:'',peers:rows,totalPeers:rows.length,reachablePeers:rows.filter(row=>row.reachable).length};
          cache={key:config.fingerprint,expires:Date.now()+15000,value};return value;
        })();
        flight={key:config.fingerprint,promise};
        const clear=()=>{if(flight?.promise===promise)flight=undefined;};
        void promise.then(clear,clear);
      }
      const value=await wait(flight.promise,signal);
      if(signal.aborted)throw new Error('request aborted');
      return value;
    },
  };
}
