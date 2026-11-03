'use client';
import {useCallback,useEffect,useState} from 'react';
// Small pieces both halves of the access page use.
export const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';

// A same-origin management endpoint: polled, and written with POST (the answer is the new state).
export function useManaged(url,interval){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let timer,off=false;
    async function poll(){
      try{const response=await fetch(url,{cache:'no-store',signal:controller.signal}),body=await response.json();if(!response.ok)throw new Error(body.error??'读取失败');if(!off){setData(body);setError('');}}
      catch(e){if(!off&&e.name!=='AbortError')setError(e instanceof TypeError?'':e.message);}
      finally{if(!off)timer=setTimeout(poll,interval);}
    }
    poll();return()=>{off=true;controller.abort();clearTimeout(timer);};
  },[url,interval]);
  const post=useCallback(async payload=>{
    setBusy(true);setError('');
    try{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),{secret,...rest}=await response.json();if(!response.ok)throw new Error(rest.error??'保存失败');setData(rest);return {ok:true,secret};}
    catch(e){setError(e.message);return {ok:false};}finally{setBusy(false);}
  },[url]);
  return {data,error,busy,post};
}
export function useCopy(onError){
  const [copied,setCopied]=useState('');
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),1800);return()=>clearTimeout(timer);},[copied]);
  return [copied,async(text,label)=>{try{await navigator.clipboard.writeText(text);setCopied(label);}catch{onError?.('复制失败，请选中文本手动复制。');}}];
}
export function NumberField({label,value,min,max,unit,onChange,disabled}){
  return <span className="ak-number"><input required disabled={disabled} aria-label={label} type="number" min={min} max={max} value={value} onChange={e=>onChange(e.target.value)}/><span>{unit}</span></span>;
}
export const TUNNEL={active:['ok','运行中'],starting:['warn','连接中'],inactive:['off','已停止'],failed:['bad','失败'],unknown:['off','未知']};
