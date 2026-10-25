import {cleanLogOutput,newLogLines} from './panel.mjs';

const probePaths=new Set(['/health','/healthz','/ready','/readyz','/metrics','/v1/models','/system_stats','/queue','/is_sleeping']);

// Only hide successful read-only probe access records. Failures, generation
// requests and engine diagnostics (including text mentioning /health) survive.
export function successfulProbe(line){
  const text=cleanLogOutput(line);
  if(/\b(?:WARNING|WARN|ERROR|FATAL|CRITICAL)\b[:\s]/.test(text))return false;
  const access=/["'](?:GET|HEAD)\s+(\S+)\s+HTTP\/\d(?:\.\d)?["']\s+([1-5]\d\d)\b/.exec(text);
  if(!access||Number(access[2])<200||Number(access[2])>=300)return false;
  const path=access[1].split('?')[0];
  return probePaths.has(path);
}
const timestamp=line=>/^(\d{4}-\d\d-\d\dT\S+Z)\s/.exec(line)?.[1];
const bounded=(lines,limit)=>{
  const tail=lines.slice(-limit);let size=tail.reduce((n,line)=>n+line.length+1,0);
  while(tail.length>1&&size>1024*1024)size-=tail.shift().length+1;
  if(tail[0]?.length>1024*1024)tail[0]=tail[0].slice(-1024*1024);
  return tail;
};
export class EngineLogBuffer {
  constructor(){this.raw=[];this.runtime=[];this.suppressed=0;this.cursor=null;this.cursorCount=0;}
  ingest(text){
    let lines=text.replace(/\n$/,'').split('\n');if(!text)return;
    if(this.raw.length&&!lines.some(timestamp))lines=newLogLines(this.raw.join('\n'),text);
    const boundary=this.cursor,count=this.cursorCount;let skipped=0;
    for(const line of lines){
      const time=timestamp(line);
      // docker --since includes the boundary timestamp. Skip only records
      // already observed there, preserving genuine repeated output.
      if(time&&boundary&&(time<boundary||(time===boundary&&skipped++<count)))continue;
      if(time){if(time===this.cursor)this.cursorCount++;else{this.cursor=time;this.cursorCount=1;}}
      this.raw.push(line);
      if(successfulProbe(line))this.suppressed++;else this.runtime.push(line);
    }
    this.raw=bounded(this.raw,1000);this.runtime=bounded(this.runtime,500);
  }
  output({includeProbes=false,since}={}){
    const cutoff=since?Date.parse(since):null;
    return (includeProbes?this.raw:this.runtime).filter(line=>cutoff===null||!timestamp(line)||Date.parse(timestamp(line))>=cutoff).join('\n');
  }
}
