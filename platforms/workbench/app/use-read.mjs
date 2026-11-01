import {useEffect,useState} from 'react';
// Poll a same-origin JSON endpoint every 5 s; keeps the last good value while a read fails.
export function useRead(path){
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();let timer,disposed=false;setSnapshot(null);setError('');
  async function poll(){try{const response=await fetch(path,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('读取失败（'+response.status+'）');const next=await response.json();if(!disposed){setSnapshot({path,value:next});setError('');}}catch(e){if(!disposed&&e.name!=='AbortError')setError(e.message);}finally{if(!disposed)timer=setTimeout(poll,5000);}}
  void poll();return()=>{disposed=true;controller.abort();clearTimeout(timer);};
 },[path]);return {value:snapshot?.path===path?snapshot.value:null,error};
}
