'use client';
import {useEffect} from 'react';

export function useDisclosureAnimation(){
  useEffect(()=>{
    const running=new Map();let disposed=false;
    function click(event){
      const summary=event.target.closest?.('summary');
      const details=summary?.parentElement;
      if(!details?.matches('details')||!details.closest('.workbench')||event.target.closest('button,a,input,select'))return;
      if(matchMedia('(prefers-reduced-motion: reduce)').matches||!details.animate)return;
      event.preventDefault();
      const previous=running.get(details),opening=previous?!previous.opening:!details.open;
      const start=details.getBoundingClientRect().height;
      previous?.animation?.cancel();
      const record={opening,animation:null};running.set(details,record);
      details.open=true;
      // onToggle may mount device charts; measure after React has committed them.
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(disposed||running.get(details)!==record)return;
        const border=2;
        const end=opening?details.scrollHeight+border:summary.getBoundingClientRect().height+border;
        const animation=details.animate([{height:start+'px',overflow:'hidden'},{height:end+'px',overflow:'hidden'}],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});
        record.animation=animation;
        animation.finished.then(()=>{if(running.get(details)!==record)return;details.open=opening;running.delete(details);}).catch(()=>{});
      }));
    }
    document.addEventListener('click',click);
    return()=>{disposed=true;document.removeEventListener('click',click);for(const record of running.values())record.animation?.cancel();};
  },[]);
}
