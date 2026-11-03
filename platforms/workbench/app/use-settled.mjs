import {useEffect,useRef,useState} from 'react';
// A status that stays readable while the work comes in bursts: "busy" is kept on screen for a few
// seconds after the last moment it was seen, so the gaps between requests of one client do not
// flip the page between busy and ready on every poll. Every other change shows at once.
export function useSettled(value,holdMs=4000){
  const [shown,setShown]=useState(value),seenBusy=useRef(0);
  useEffect(()=>{
    if(value==='busy')seenBusy.current=Date.now();
    const wait=shown==='busy'&&value==='ready'?holdMs-(Date.now()-seenBusy.current):0;
    if(wait>0){const timer=setTimeout(()=>setShown(value),wait);return()=>clearTimeout(timer);}
    setShown(value);
  },[value]);
  return shown;
}
