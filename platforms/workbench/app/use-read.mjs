import {useEffect,useState} from 'react';
// Poll a same-origin JSON endpoint every 5 s; keeps the last good value while a read fails.
// With keep, the previous path's value stays on screen until the new one arrives (paging, filters),
// so lists do not collapse and jump; stale tells the caller it is looking at the old answer.
export function useRead(path,{keep=false,interval=5000}={}){
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState('');
 useEffect(()=>{if(!path)return;const controller=new AbortController();let timer,disposed=false;setError('');
  async function poll(){try{const response=await fetch(path,{cache:'no-store',signal:controller.signal});if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error??'读取失败（'+response.status+'）');}const next=await response.json();if(!disposed){setSnapshot({path,value:next});setError('');}}catch(e){if(!disposed&&e.name!=='AbortError')setError(e.message);}finally{if(!disposed&&interval)timer=setTimeout(poll,interval);}}
  void poll();return()=>{disposed=true;controller.abort();clearTimeout(timer);};
 },[path,interval]);
 const current=snapshot?.path===path;
 return {value:current||keep?snapshot?.value??null:null,stale:!!snapshot&&!current,error};
}
