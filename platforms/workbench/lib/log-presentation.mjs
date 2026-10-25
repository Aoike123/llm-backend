// Presentation only: original log lines remain available for inspection and copying.
export function presentLog(raw){
 const stamp=raw.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s*/);
 const timestamp=stamp?.[1]??null;
 const time=timestamp?new Date(timestamp).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
 let level=/\b(ERROR|FATAL|CRITICAL|Traceback|Exception)\b|错误|异常/i.test(raw)?'error':/\bWARN(?:ING)?\b|警告/i.test(raw)?'warning':'info';
 const message=raw.slice(stamp?.[0].length??0).replace(/^\([^)]*pid=\d+\)\s*/,'').replace(/^(?:INFO|WARNING|WARN|ERROR|FATAL|CRITICAL)(?:\s+\d\d-\d\d\s+\d\d:\d\d:\d\d)?\s*(?:\[[^\]]+\])?\s*:?\s*/,'');
 const number=pattern=>{const match=raw.match(pattern);return match?Number(match[1]):null;};
 const generation=number(/Avg generation throughput:\s*([\d.]+) tokens\/s/);
 const prompt=number(/Avg prompt throughput:\s*([\d.]+) tokens\/s/);
 const running=number(/Running:\s*(\d+) reqs/),waiting=number(/Waiting:\s*(\d+) reqs/),kv=number(/GPU KV cache usage:\s*([\d.]+)%/);
 let kind='message',title='',metrics=[];
 if(generation!==null||prompt!==null){kind='throughput';title='引擎吞吐';metrics=[['生成',generation,'tok/s'],['输入',prompt,'tok/s'],['执行',running,'路'],['等待',waiting,'路'],['KV',kv,'%']].filter(([,n])=>n!==null);}
 else if(/SpecDecoding metrics:/.test(raw)){kind='speculation';title='推测解码';metrics=[['接受长度',number(/Mean acceptance length:\s*([\d.]+)/),'tokens'],['接受率',number(/Avg Draft acceptance rate:\s*([\d.]+)%/),'%'],['接受吞吐',number(/Accepted throughput:\s*([\d.]+)/),'tok/s']].filter(([,n])=>n!==null);}
 else if(/\bPrompt executed in [\d.]+ seconds\b/.test(raw)){kind='completion';title='任务执行完成';metrics=[['执行耗时',number(/Prompt executed in ([\d.]+) seconds/),'秒']];}
 else if(/\d+%\|.*\d+\/\d+\s*\[/.test(raw)){
  const progress=raw.match(/(\d+)%\|.*?\|\s*(\d+)\/(\d+)\s*\[([^<,\]]+)(?:<([^,\]]+))?(?:,\s*([\d.]+)(it\/s|s\/it))?/);
  if(progress&&Number(progress[1])<=100&&Number(progress[2])<=Number(progress[3])){kind='progress';title='采样进度';metrics=[['进度',Number(progress[1]),'%'],['采样步',Number(progress[2]),'/ '+progress[3]],['已用',progress[4],'']];if(progress[5]&&progress[5]!=='?')metrics.push(['预计剩余',progress[5],'']);if(progress[6])metrics.push(['步速',Number(progress[6]),progress[7]]);}
 }
 else {const request=raw.match(/"(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})/);if(request){if(Number(request[3])>=400)level='error';kind='request';title=`${request[1]} ${request[2]}`;metrics=[['HTTP',Number(request[3]),'']];}}
 return {raw,timestamp,time,level,message,kind,title,metrics};
}
export function logDigest(raw){
 const row=presentLog(raw);
 return row.metrics.length?`${row.title} · ${row.metrics.map(([name,value,unit])=>`${name} ${value}${unit?' '+unit:''}`).join(' · ')}`:row.message;
}
