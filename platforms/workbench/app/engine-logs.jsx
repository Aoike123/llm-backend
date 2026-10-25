'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Icon,ActionButton} from './ui-controls.mjs';
import {presentLog,logDigest} from '../lib/log-presentation.mjs';
import {serviceName,newLogLines,logSummary,engineLogText,fmt} from '../lib/panel.mjs';

function LogRows({rows}){
 return rows.map((row,index)=><div className={'log-entry level-'+row.level+' kind-'+row.kind} key={index}><time title={row.timestamp??''}>{row.time||'—'}</time><span className="log-level">{row.level==='error'?'错误':row.level==='warning'?'警告':row.kind==='request'?'请求':row.kind==='throughput'?'吞吐':row.kind==='speculation'?'解码':row.kind==='progress'?'采样':row.kind==='completion'?'完成':'日志'}</span><div className="log-entry-body">{row.metrics.length?<details className="log-entry-detail"><summary><span className="log-entry-title">{row.title}</span><span className="log-entry-metrics">{row.metrics.map(([label,value,unit])=><span key={label}>{label} <b>{value}</b> <small>{unit}</small></span>)}</span><span className="log-detail-hint">原文 <Icon name="chevron"/></span></summary><pre>{row.raw}</pre></details>:<span className="log-message">{row.message||' '}</span>}</div></div>);
}
function LogHighlights({rows,model}){
 const latest=rows.findLast(row=>model==='llm'?row.kind==='throughput':['progress','completion'].includes(row.kind));
 if(!latest)return null;
 return <div className="log-highlights"><div className="log-sample-label">{model==='llm'?'最近采样':latest.title}<time>{latest.time?latest.time+' · 北京时间':'最近保留的日志记录'}</time></div>{latest.metrics.map(([label,value,unit])=><div className={'log-highlight '+(label==='生成'?'primary':'')} key={label}><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>)}</div>;
}

export default function EngineLogs({model,data}){
  const [includeProbes,setIncludeProbes]=useState(false),[logs,setLogs]=useState(null),[error,setError]=useState(''),[visible,setVisible]=useState(false),[collapsed,setCollapsed]=useState(false),[open,setOpen]=useState(false);
  const [following,setFollowing]=useState(true),[unread,setUnread]=useState(0),[filter,setFilter]=useState('all'),[summary,setSummary]=useState(null),[errors,setErrors]=useState(0),[copied,setCopied]=useState(false),[rawView,setRawView]=useState(false);
  const anchor=useRef(null),tail=useRef(null),drawerTail=useRef(null),dialog=useRef(null),orb=useRef(null),previous=useRef({session:null,text:''}),follow=useRef(true),opened=useRef(false),summaryTimer=useRef(null),copyTimer=useRef(null),consoleAnimation=useRef(null),drawerAnimation=useRef(null);
  const switching=(data?.switching_target===model)||(model==='llm'&&!!data?.pending_llm_mode);
  const source=logs?.model===model?logs:null;
  const startup=switching||source?.switching;
  const text=engineLogText(source,startup);
  const rows=useMemo(()=>text.split('\n').filter(Boolean).map(presentLog),[text]);
  const shownRows=useMemo(()=>rows.filter(row=>filter==='all'||(filter==='error'?row.level==='error':row.level!=='info')),[rows,filter]);
  const filtered=filter==='all'?text:shownRows.map(row=>row.raw).join('\n');
  const event=source?.engine_switch?.events?.at(-1)??(model==='llm'?source?.events?.at(-1):null);
  const policy=startup?source?.target_policy:source?.engine_policy;
  const historical=data?.current_model!==model&&!startup;
  const noOutput=filter!=='all'?'当前筛选下没有输出':startup?'等待引擎启动输出…':historical?'该引擎暂无保留的运行日志。':'引擎运行中，等待任务输出。';

  useEffect(()=>{
    let disposed=false,timer;const controller=new AbortController();
    async function poll(){
      try{
        const response=await fetch('/api/engine-logs?model='+encodeURIComponent(model)+(includeProbes?'&include_probes=1':''),{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('日志连接暂时中断，正在重试。');
        const result=await response.json();if(disposed||result.model!==model)return;
        const isStartup=result.switching;
        const output=engineLogText(result,isStartup);
        const session=[model,result.container_id??result.containers?.join(','),isStartup?'startup':'runtime',includeProbes?'raw':'runtime-only',result.engine_switch?.id??result.mode_switch?.id??''].join(':');
        const initial=previous.current.session!==session;
        const added=initial?output.split('\n').filter(Boolean).slice(-1):newLogLines(previous.current.text,output);
        previous.current={session,text:output};setLogs(result);setError(result.log_error??'');
        if(initial){setUnread(0);setErrors(0);setSummary(null);follow.current=true;setFollowing(true);}
        if(added.length&&(result.available||result.engine_switch?.events?.length||result.events?.length)){
          const next=logSummary(added);next.text=logDigest(next.text);setSummary(old=>old&&((old.level==='error'&&next.level!=='error')||(old.level==='warning'&&next.level==='info'))?old:{...next,count:added.length,id:Date.now()});
          if(!follow.current)setUnread(n=>n+added.length);
          if(!opened.current)setErrors(n=>n+next.errors);
          clearTimeout(summaryTimer.current);
          if(next.level==='info')summaryTimer.current=setTimeout(()=>setSummary(old=>old?.level==='info'?null:old),12000);
        }
      }catch(e){if(!disposed)setError(e.message||'日志连接暂时中断，正在重试。');}
      finally{if(!disposed)timer=setTimeout(poll,switching?1000:3000);}
    }
    poll();return()=>{disposed=true;controller.abort();clearTimeout(timer);clearTimeout(summaryTimer.current);clearTimeout(copyTimer.current);};
  },[model,switching,includeProbes]);

  useEffect(()=>{
    const el=anchor.current;if(!el)return;
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{threshold:.15});
    observer.observe(el);return()=>observer.disconnect();
  },[collapsed]);
  useEffect(()=>{
    opened.current=open;const el=dialog.current;
    if(open){el?.showModal();setErrors(0);setSummary(null);}else if(el?.open){el.close();orb.current?.focus();}
  },[open]);
  useEffect(()=>{if(follow.current){for(const el of [tail.current,drawerTail.current])if(el)el.scrollTop=el.scrollHeight;setUnread(0);}},[filtered,following,open,rawView]);


  useEffect(()=>()=>{consoleAnimation.current?.cancel();drawerAnimation.current?.cancel();},[]);
  function collapseConsole(next){
    const el=anchor.current;
    consoleAnimation.current?.cancel();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches||!el?.animate){setCollapsed(next);return;}
    if(next){
      const animation=el.animate([{height:el.offsetHeight+'px',opacity:1},{height:'48px',opacity:.3}],{duration:240,easing:'ease-in-out'});
      consoleAnimation.current=animation;
      animation.finished.then(()=>{if(consoleAnimation.current===animation){setCollapsed(true);consoleAnimation.current=null;}}).catch(()=>{});
    }else {
      setCollapsed(false);
      requestAnimationFrame(()=>{if(!el.isConnected)return;consoleAnimation.current=el.animate([{height:'48px',opacity:.3},{height:el.scrollHeight+'px',opacity:1}],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});});
    }
  }
  function closeDrawer(){
    const el=dialog.current;
    drawerAnimation.current?.cancel();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches||!el?.animate){setOpen(false);return;}
    const animation=el.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY(28px)',opacity:0}],{duration:200,easing:'ease-in'});
    drawerAnimation.current=animation;
    animation.finished.then(()=>{if(drawerAnimation.current===animation){setOpen(false);drawerAnimation.current=null;}}).catch(()=>{});
  }
  function scroll(e){const el=e.currentTarget,next=el.scrollHeight-el.scrollTop-el.clientHeight<28;follow.current=next;setFollowing(next);if(next)setUnread(0);}
  function toggleFollow(){follow.current=!following;setFollowing(!following);}
  async function copy(){try{await navigator.clipboard.writeText(text);setCopied(true);clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopied(false),2000);}catch{setError('无法复制，请在日志中选中文本复制。');}}
  const controls=<><ActionButton className="log-action log-view-toggle" aria-pressed={rawView} onClick={()=>setRawView(value=>!value)}>{rawView?'切换易读视图':'查看原始文本'}</ActionButton><ActionButton className="log-action" aria-pressed={includeProbes} onClick={()=>setIncludeProbes(value=>!value)}>{includeProbes?'隐藏健康探测':'显示健康探测'}</ActionButton><label className="log-filter"><Icon name="filter"/><span className="sr-only">日志级别</span><select aria-label="日志级别" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部输出</option><option value="warning">警告与错误</option><option value="error">仅错误</option></select><Icon name="chevron"/></label><ActionButton icon={copied?'check':'copy'} className={'log-action'+(copied?' is-copied':'')} onClick={copy}><span>{copied?'已复制':'复制日志'}</span></ActionButton></>;
  const context=<><div className="console-context"><span>{historical?'未加载 · 保留的容器日志':startup?'正在准备引擎 · 启动输出':'当前运行引擎 · 实时输出'}{model==='llm'&&policy?` · ${policy.context_tokens/1024}K · ${policy.concurrency} 路 · ${policy.eager?'Eager':'图捕获'}`:''}</span><small>{source?.containers?.join(' · ')??'日志来源读取中'}{source?.container_id?' · 实例 '+source.container_id.slice(0,12):''}</small></div><LogHighlights rows={rows} model={model}/>{event&&<div className="console-event"><span>切换进度</span><p title={event.message}>{event.message}</p></div>}{error&&<p className="log-error" role="alert">{error}</p>}</>;
  const foot=<div className="console-foot"><i className={'journal-dot'+(source?.available&&!error?'':' waiting')}/><span>{historical?'历史输出':source?.available?(startup?'启动日志 · 每 1 秒更新':'运行日志 · 每 3 秒更新'):'等待引擎日志'}{!includeProbes&&source?.suppressed_probe_lines>0?' · 已隐藏 '+source.suppressed_probe_lines+' 条成功探测':''}{unread>0?` · 新增 ${unread} 条`:''}</span><button type="button" className="console-follow" aria-label={following?'暂停自动跟随日志':'开启自动跟随日志'} aria-pressed={following} onClick={toggleFollow}><span className="follow-toggle" aria-hidden="true"><i/></span><span>{following?'自动跟随':'跟随已暂停'}</span></button></div>;
  return <>
    <div ref={anchor} className="log-anchor">
      {collapsed?<ActionButton icon="terminal" className="restore-console" onClick={()=>collapseConsole(false)}>展开 {serviceName(model)} 引擎日志 <Icon name="chevron"/></ActionButton>:<section className="switch-console engine-console" aria-label={serviceName(model)+' 引擎输出'}><div className="console-head"><span className="console-lights" aria-hidden="true"><i/><i/><i/></span><strong>{serviceName(model)} · 引擎输出</strong><div className="log-controls">{controls}<ActionButton variant="quiet" icon="external" className="log-action log-icon-action" aria-label="放大引擎日志" title="放大查看" onClick={()=>setOpen(true)}/><ActionButton variant="quiet" className="log-action log-icon-action" aria-label="收起日志为悬浮球" title="收起日志" onClick={()=>collapseConsole(true)}><Icon name="collapse"/></ActionButton></div></div>{context}<div className={"console-native log-output"+(rawView?" raw-view":"")} ref={tail} tabIndex={0} aria-label="引擎日志内容" onScroll={scroll}>{rawView?<pre>{filtered||noOutput}</pre>:shownRows.length?<LogRows rows={shownRows}/>:<div className="log-empty">{noOutput}</div>}</div>{foot}</section>}
    </div>
    {(collapsed||!visible)&&!open&&<div className="log-dock">
      {summary&&<button type="button" key={summary.id} className={'log-bubble log-'+summary.level} aria-label="查看最新日志详情" onClick={()=>setOpen(true)}><span>{serviceName(model)} · {summary.level==='error'?'错误':summary.level==='warning'?'警告':historical?'历史日志':'最新日志'}{summary.count>1?' · 新增 '+summary.count+' 条':''}</span><p>{summary.text}</p><small>查看完整输出 <Icon name="external"/></small></button>}
      <button className={'log-orb'+(errors?' has-errors':'')} ref={orb} aria-label={`展开 ${serviceName(model)} 日志${errors?'，'+errors+' 条新错误':''}`} onClick={()=>setOpen(true)}><Icon name="terminal"/>{errors>0?<b>{fmt(errors,0)}</b>:<i/>}</button>
    </div>}
    <dialog className="log-drawer" ref={dialog} aria-labelledby="log-drawer-title" onCancel={e=>{e.preventDefault();closeDrawer();}} onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDrawer();}}}><div className="console-head"><strong id="log-drawer-title">{serviceName(model)} · 引擎输出</strong><div className="log-controls">{controls}<ActionButton variant="quiet" className="log-action log-icon-action" aria-label="关闭日志弹窗" title="关闭日志" onClick={closeDrawer}><Icon name="close"/></ActionButton></div></div>{context}<div className={"console-native log-output"+(rawView?" raw-view":"")} ref={drawerTail} tabIndex={0} aria-label="展开的引擎日志" onScroll={scroll}>{rawView?<pre>{filtered||noOutput}</pre>:shownRows.length?<LogRows rows={shownRows}/>:<div className="log-empty">{noOutput}</div>}</div>{foot}</dialog>
  </>;
}
