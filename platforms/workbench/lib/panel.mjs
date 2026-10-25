export const SERVICES=[
  {id:'llm',name:'Qwen',version:'3.8 · 27B',description:'W3A4 · 文本与视觉推理',kind:'语言与视觉',type:'language',accent:'#b8a3ff',symbol:'Q'},
  {id:'flux',name:'FLUX',version:'2 · klein',description:'图像生成 · Paiton / Diffusers',kind:'图像生成',type:'image',accent:'#d8be8f',symbol:'F'},
  {id:'qwen-image',name:'Qwen-Image',version:'2.1',description:'图像生成与编辑',kind:'图像生成',type:'image',accent:'#9fd4c1',symbol:'I'},
  {id:'h3',name:'ComfyUI',version:'',description:'视频生成 · H3 原生工作流',kind:'原生工作流',type:'video',accent:'#8cbede',symbol:'C'},
  {id:'tts',name:'CosyVoice',version:'3 · RL',description:'语音合成 · 零样本克隆 · 拼音标注',kind:'语音合成',type:'audio',accent:'#d9a7a0',symbol:'V'},
];
export const serviceName=id=>SERVICES.find(s=>s.id===id)?.name??'待机';
export const cleanLogOutput=text=>(text??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r\n?/g,'\n');
export const fmt=(v,d=1)=>v==null||!Number.isFinite(v)?'—':v.toLocaleString('zh-CN',{maximumFractionDigits:d});
export const clock=t=>Number.isFinite(t)?new Date(t*1000).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Shanghai'}):'—';
export function serviceState(data,model){
  if(!data)return 'loading';
  if(model==='h3'&&data.comfyui?.available&&!data.switching)return data.comfyui.running.length?'busy':'ready';
  if(data.switching_target===model||(model==='llm'&&data.pending_llm_mode))return 'switching';
  if(data.current_model===model&&!data.switching)return data.active>0?'busy':'ready';
  return 'inactive';
}
export function serviceRecords(data,model,minutes){
  return (data?.recent??[]).filter(r=>r.model===model&&(minutes===undefined||r.finished_at>=data.timestamp-minutes*60));
}
// Container tails overlap and can roll over. Compare the longest suffix/prefix,
// including repeated identical lines, rather than counting all lines on each poll.
export function newLogLines(previous,next){
  const before=previous.split('\n').filter(Boolean),after=next.split('\n').filter(Boolean);
  if(previous===next)return [];
  if(!before.length)return after;
  for(let n=Math.min(before.length,after.length);n>0;n--){
    if(before.slice(-n).every((line,i)=>line===after[i]))return after.slice(n);
  }
  return after;
}
export function logSummary(lines){
  const errors=lines.filter(line=>/\b(error|fatal|traceback|exception)\b|错误|异常/i.test(line));
  const warnings=lines.filter(line=>/\bwarn(?:ing)?\b|警告/i.test(line));
  return {text:errors.at(-1)??warnings.at(-1)??lines.at(-1)??'',level:errors.length?'error':warnings.length?'warning':'info',errors:errors.length};
}

// Startup output differs by engine: media engines stream their normal container log.
export function engineLogText(logs,startup=false){
  if(!logs)return '正在读取该服务引擎输出…';
  const events=logs.engine_switch?.events??logs.events??[];
  const progress=events.map(e=>`[${e.source??'scheduler'}] ${e.message}`).join('\n');
  const output=startup?(logs.model==='llm'?logs.startup_output:logs.startup_output??logs.output):logs.output;
  return cleanLogOutput([progress,output??(startup?'等待目标引擎创建，启动输出将自动显示…':'等待引擎输出…')].filter(Boolean).join('\n\n'));
}

export function followedEngine(data){
 return data?.pending_llm_mode?'llm':data?.switching_target??data?.current_model??null;
}
export function engineFollowChanged(previous,data){
 const next=followedEngine(data);
 return previous!==undefined&&next!==null&&next!==previous;
}
