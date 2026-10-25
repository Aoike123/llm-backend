'use client';
const fmt=(v,d=1)=>v==null||!Number.isFinite(v)?'—':v.toLocaleString('zh-CN',{maximumFractionDigits:d});
export default function CpuVisionCard({values:v={}}){
  const groups=[
    ['计算资源',[
      ['CPU 使用率',v.vision_cpu,'%',v.vision_threads?`按 ${fmt(v.vision_threads,0)} 个线程归一 · 近 1 分钟`:'等待线程信息'],
      ['容器内存',v.vision_memory==null?null:v.vision_memory/2**30,'GiB',v.vision_memory_limit==null?'当前容器总占用':`上限 ${fmt(v.vision_memory_limit/2**30)} GiB`],
    ]],
    ['编码性能',[
      ['平均编码耗时',v.vision_encode,'秒','近 5 分钟 · 不含缓存命中与排队'],
      ['最近一次编码',v.vision_last_encode,'秒','本次启动后的最近一次计算'],
    ]],
    ['特征缓存',[
      ['缓存命中率',v.vision_cache_hit,'%','近 5 分钟 · 无请求时显示 —'],
      ['缓存占用',v.vision_cache==null?null:v.vision_cache/2**20,'MiB',v.vision_cache_limit==null?'等待缓存容量':`上限 ${fmt(v.vision_cache_limit/2**20,0)} MiB`],
    ]],
  ];
  return <section className="vision-panel" aria-label="CPU 图像计算">
    <div className="vision-overview"><p>CPU 编码图像特征，GPU 继续处理文本。</p><div><span>{v.vision_threads!=null?fmt(v.vision_threads,0)+' 个计算线程':'线程信息待采集'}</span><span>本次启动编码 <b>{fmt(v.vision_encodes,0)}</b> 次</span></div></div>
    <div className="vision-groups">{groups.map(([title,rows])=><section className="vision-group" key={title}><h3>{title}</h3>{rows.map(([name,value,unit,note])=><div className="vision-metric" key={name}><span className="label">{name}</span><div className="vision-value">{fmt(value)}<span>{value==null?'待采集':unit}</span></div><p className="note">{note}</p></div>)}</section>)}</div>
    <div className="vision-footer"><span>本次启动统计</span><span>缓存命中 <b>{fmt(v.vision_hits,0)}</b> 次</span><span className={v.vision_failures>0?'bad':''}>编码失败 <b>{fmt(v.vision_failures,0)}</b> 次</span></div>
  </section>;
}
