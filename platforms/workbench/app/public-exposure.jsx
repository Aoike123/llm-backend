'use client';
import {ActionButton,Icon,Switch} from './ui-controls.mjs';
import {time,useCopy,TUNNEL} from './access-shared';
// The internet-facing switchboard: whether the tunnel is up, which public routes are on, what the
// public address actually does for each (checked from outside on demand), and the proxy's path
// list derived from the switches. The gateway enforces the switches itself, so turning a route
// off takes effect at once; turning one on also needs the proxy to forward it (see the check).
const GROUPS={chat:'聊天',sync:'媒体 · 同步'};
// What a check saw, in words, for a route that is on or off.
function verdict(route,probe){
  const seen=probe?.results.find(r=>r.id===route.id);
  if(!seen)return null;
  if(seen.exposed!==route.exposed)return ['stale','待重新检查'];
  if(seen.seen==='unreachable')return ['bad','无法连接'];
  if(route.exposed)return seen.seen==='reachable'?['ok','外网可达']:seen.seen==='proxy-refused'?['bad','代理未放行']:['bad','异常 '+seen.status];
  return seen.seen==='reachable'?['bad','仍可到达']:['off','已关闭'];
}
function Stat({label,value,tone}){return <div className={tone?'is-'+tone:''}><strong>{value}</strong><span>{label}</span></div>;}

export default function PublicExposure({data,post,busy,setError}){
  const [copied,copy]=useCopy(setError);
  if(!data)return <div className="empty">正在读取公网状态…</div>;
  const {tunnel,stats,probe}=data,[tone,tunnelText]=TUNNEL[tunnel.state],routes=data.routes;
  const problems=(probe?.results??[]).filter(r=>!r.ok&&r.exposed===routes.find(x=>x.id===r.id)?.exposed);
  const groups=Object.keys(GROUPS).map(id=>[id,routes.filter(r=>r.group===id)]).filter(([,list])=>list.length);
  return <div className="ak-panel">
    <section className="ak-card ak-link">
      <div className="ak-link-main">
        <span className={'ak-badge is-'+tone}><i/>隧道{tunnelText}</span>
        <p>{tunnel.target?<>反向 SSH → <code>{tunnel.target}</code> 的 <code>127.0.0.1:{tunnel.remote_port}</code></>:'反向 SSH 隧道'}{tunnel.state==='active'&&tunnel.since&&<> · 自 {time(tunnel.since)}{tunnel.restarts?'，重连 '+tunnel.restarts+' 次':''}</>}</p>
        {tunnel.state!=='active'&&<p className="ak-warn">隧道没有运行，公网请求到不了本机。启动：<code>systemctl --user enable --now {tunnel.unit}</code></p>}
        <div className="ak-address"><span>公网地址</span>{data.base?<><code>{data.base}</code><ActionButton variant="quiet" icon="copy" onClick={()=>copy(data.base,'地址')}>{copied==='地址'?'已复制':'复制'}</ActionButton></>:<em>未检测到：设置 WORKBENCH_PUBLIC_BASE，或放置 platforms/public-api/Caddyfile.&lt;域名&gt;</em>}</div>
      </div>
      <Switch checked={data.master} busy={busy} onChange={enabled=>post({action:'master',enabled})} label="允许公网访问" description={data.master?'关闭后所有公网请求立即返回 404；本机与 MCP 不受影响':'已关闭：公网请求全部被拒绝'}/>
    </section>

    <section className="ak-stats" aria-label="公网请求统计">
      <Stat label="放行" value={stats.served}/><Stat label="密钥无效或缺失" value={stats.denied} tone={stats.denied?'warn':''}/><Stat label="访问了已关闭的接口" value={stats.blocked} tone={stats.blocked?'warn':''}/>
      <p className="muted tiny">自 {time(stats.since)} 起{stats.last_at?' · 最近一次 '+time(stats.last_at):' · 暂无公网请求'}（重启网关后清零）</p>
    </section>

    {groups.map(([id,list])=><section className={'ak-card'+(data.master?'':' is-dim')} key={id}>
      <div className="ak-toolbar"><h2>{GROUPS[id]}</h2><span className="muted tiny">{list.filter(r=>r.exposed).length} / {list.length} 放行</span></div>
      <ul className="ak-routes">{list.map(r=>{const v=verdict(r,probe),s=stats.by_path[r.path];
        return <li key={r.id} className={r.exposed?'':'is-off'}>
          <Switch checked={r.exposed} busy={busy} disabled={!data.master} onChange={exposed=>post({action:'set',id:r.id,exposed})} label={<><span className={'ak-method m-'+r.method.toLowerCase()}>{r.method}</span><code>{r.path}</code></>} description={r.purpose+(r.models?' · 主推 '+r.models.primary:'')}/>
          <span className="ak-route-meta">{s?<small>放行 {s.served} · 无密钥 {s.denied} · 拦截 {s.blocked}</small>:<small>暂无请求</small>}{v&&<span className={'ak-badge is-'+v[0]}>{v[1]}</span>}</span>
        </li>;})}</ul>
    </section>)}

    <section className="ak-card">
      <div className="ak-toolbar"><h2>公网代理</h2>
        <ActionButton icon="follow" disabled={busy||!data.base} onClick={()=>post({action:'probe'})}>{busy?'检查中…':'检查外网'}</ActionButton></div>
      <p className="note">公网服务器上的 Caddy 把 <code>/v1/*</code> 和 <code>/artifacts/*</code> 整体转给网关，由网关决定放行哪些接口。所以上面的开关立即生效，新增或停用引擎也不用再改 Caddy。</p>
      {probe&&<div className={'ak-probe '+(problems.length?'is-bad':'is-ok')}>
        <strong>{problems.length?problems.length+' 处与预期不一致':'外网表现与这里的设置一致'}</strong><span className="muted tiny">检查于 {time(probe.at)} · {probe.base}</span>
        {problems.map(r=><p key={r.id}><code>{r.path}</code> {r.seen==='proxy-refused'?'已放行，但公网代理没有转发它：Caddy 还是旧的路径清单，按下面的配置更新后重载。':r.seen==='unreachable'?'无法连接到公网地址，检查隧道、域名和防火墙。':'外网返回 '+r.status+'，与设置不符。'}</p>)}
      </div>}
      <div className="ak-code"><div><span>Caddy 配置（放进 api 站点，替换原来的路径清单）</span><ActionButton variant="quiet" icon="copy" onClick={()=>copy(data.caddy,'配置')}>{copied==='配置'?'已复制':'复制'}</ActionButton></div><pre>{data.caddy}</pre></div>
    </section>
  </div>;
}
