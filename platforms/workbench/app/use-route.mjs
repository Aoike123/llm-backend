'use client';
import {useCallback,useEffect,useState} from 'react';
// The console's place lives in the URL hash (#/section/service/view?job=…), so a refresh, the back
// button or a shared link return to the same page, and nothing but a click moves the view.
export const SECTIONS=['overview','library','tasks','services','engines','api','mcp','keys'];
export function parseRoute(hash){
  const [path,query='']=String(hash??'').replace(/^#\/?/,'').split('?');
  const [section,service,view]=path.split('/').filter(Boolean).map(decodeURIComponent);
  const params=new URLSearchParams(query);
  return {section:SECTIONS.includes(section)?section:'overview',service:service??null,view:view??null,job:params.get('job')};
}
export function formatRoute({section='overview',service=null,view=null,job=null}){
  const path=[section,...(section==='services'&&service?[service,...(view?[view]:[])]:[])].map(encodeURIComponent).join('/');
  return '#/'+path+(job?'?job='+encodeURIComponent(job):'');
}
export function useRoute(){
  const [route,setRoute]=useState(()=>parseRoute(''));
  useEffect(()=>{const read=()=>setRoute(parseRoute(location.hash));read();addEventListener('hashchange',read);return()=>removeEventListener('hashchange',read);},[]);
  // Opening a job keeps the page underneath; switching pages pushes history, opening details does not.
  const navigate=useCallback((change,{replace=Object.keys(change).every(k=>k==='job')}={})=>{
    const next=formatRoute({...parseRoute(location.hash),...('section' in change&&!('job' in change)?{job:null}:{}),...change});
    if(next===location.hash)return;
    if(replace)history.replaceState(null,'',next);else history.pushState(null,'',next);
    setRoute(parseRoute(next));
  },[]);
  return [route,navigate];
}
