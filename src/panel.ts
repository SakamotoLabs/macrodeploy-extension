import * as vscode from "vscode";

import type { AuditCategory, AuditEvent } from "./audit";

export type PanelTheme = "auto" | "dark" | "light";

// The real MacroDeploy mark (inline so it renders inside the webview).
const LOGO_SVG =
  '<svg width="22" height="22" viewBox="0 0 48 48" style="vertical-align:middle">' +
  '<rect width="48" height="48" rx="11" fill="#16a34a"/>' +
  '<g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 25 L21 34 L38 13"/><path d="M30 13 L38 13 L38 21"/></g></svg>';

export interface PanelSettings {
  credential: string;
  workerModel: string;
  synthModel: string;
  theme: PanelTheme;
}

// Webview panel beside the editor. Phase 1: SELECT — editable settings + expandable
// audit groups with per-item checkboxes. Phase 2: PROGRESS — live cards → findings.
export class AuditPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly onCancel: () => void;
  private readonly onRun: (selection: Record<string, string[]>) => void;
  private readonly onSetting: (key: string, value: string) => void;
  private disposed = false;

  private readonly onPickFolder: () => void;

  constructor(opts: {
    repo: string;
    credentialLabel: string;
    notes?: string[];
    settings: PanelSettings;
    categories: AuditCategory[];
    onRun: (selection: Record<string, string[]>) => void;
    onSetting: (key: string, value: string) => void;
    onPickFolder: () => void;
    onCancel: () => void;
  }) {
    this.onCancel = opts.onCancel;
    this.onRun = opts.onRun;
    this.onSetting = opts.onSetting;
    this.onPickFolder = opts.onPickFolder;
    this.panel = vscode.window.createWebviewPanel(
      "macrodeployAudit",
      "MacroDeploy — Code Audit",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html(opts);
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === "cancel") this.onCancel();
      else if (m?.type === "run" && m.selection) this.onRun(m.selection);
      else if (m?.type === "setting" && m.key) this.onSetting(String(m.key), String(m.value ?? ""));
      else if (m?.type === "pickFolder") this.onPickFolder();
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.onCancel();
    });
  }

  post(msg: unknown) {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }
  event(e: AuditEvent) {
    this.post(e);
  }
  saved(url: string | null) {
    this.post({ type: "saved", url });
  }
  fail(message: string) {
    this.post({ type: "fatal", message });
  }
  /** Update the credential summary after a settings change re-resolves it. */
  credential(label: string) {
    this.post({ type: "credlabel", label });
  }
  /** Update the target folder/repo after the user picks one. */
  target(path: string) {
    this.post({ type: "target", path });
  }

  private html(opts: {
    repo: string;
    credentialLabel: string;
    notes?: string[];
    settings: PanelSettings;
    categories: AuditCategory[];
  }): string {
    const nonce = String(Date.now()) + Math.floor(performance.now()).toString(36);
    const cats = JSON.stringify(
      opts.categories.map((c) => ({ key: c.key, title: c.title, on: !!c.defaultOn, items: c.items })),
    );
    const s = opts.settings;
    const themeAttr = s.theme === "auto" ? "" : ` data-theme="${s.theme}"`;
    const sel = (id: string, val: string, optsArr: [string, string][]) =>
      `<select id="${id}">${optsArr.map(([v, l]) => `<option value="${esc(v)}"${v === val ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const MODELS: [string, string][] = [
      ["", "Default (Claude Code setting)"],
      ["claude-haiku-4-5-20251001", "Haiku 4.5 — fast & cheap"],
      ["claude-sonnet-4-6", "Sonnet 4.6 — balanced"],
      ["claude-opus-4-8", "Opus 4.8 — strongest"],
    ];
    const modelSel = (id: string, val: string) => {
      const o = [...MODELS];
      if (val && !o.some((x) => x[0] === val)) o.push([val, val]); // keep a custom/saved id
      return sel(id, val, o);
    };
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root{--g:#2ea043;--g2:#3fb950;--ink:#e6efe9;--mut:#8b9a90;--line:rgba(255,255,255,.10);--bg:#0e1312;--card:#161c19;--code:#1e2622;--codeink:#cfe3d6;--field:#111714}
  body[data-theme="light"],body[data-theme="auto"].vscode-light{--g:#16a34a;--g2:#15803d;--ink:#1a2b22;--mut:#5b6b63;--line:rgba(0,0,0,.08);--bg:#f7f9f8;--card:#fff;--code:#eef2f0;--codeink:#2a3b32;--field:#fff}
  *{box-sizing:border-box}
  body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:18px 20px}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
  .brand .mk{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--g);color:#fff;font-size:13px}
  .sub{color:var(--mut);font-size:12px;margin:2px 0 14px}
  .meta{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--mut);line-height:1.7}
  .meta b{color:var(--ink);font-weight:600}.warn{color:#e3b341}
  h3{font-size:13px;margin:16px 0 8px}
  select,input[type=text]{font:inherit;font-size:12px;background:var(--field);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:5px 8px}
  details.settings{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px 14px;margin-bottom:12px}
  details.settings summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--ink)}
  .srow{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:12px;color:var(--mut)}
  .srow label{width:90px}.srow select,.srow input{flex:1}
  .selhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .linkbtn{background:none;border:0;color:var(--g2);cursor:pointer;font:inherit;font-size:12px;padding:0}
  .grp{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:7px;overflow:hidden}
  .grphead{display:flex;align-items:center;gap:9px;padding:9px 12px;cursor:pointer;user-select:none}
  .grphead .t{font-weight:600;flex:1}.grphead .cnt{color:var(--mut);font-size:11px}
  .caret{color:var(--mut);transition:transform .12s;display:inline-block}
  .grp.open .caret{transform:rotate(90deg)}
  input[type=checkbox]{accent-color:var(--g);width:15px;height:15px;flex:none}
  .items{padding:0 12px 8px 40px}.items.hidden{display:none}
  .items label{display:flex;align-items:center;gap:9px;padding:4px 0;cursor:pointer;color:var(--ink)}
  button.primary{font:inherit;font-weight:600;padding:9px 16px;border:0;border-radius:9px;background:var(--g);color:#fff;cursor:pointer}
  button.primary:hover{background:var(--g2)}button.primary:disabled{opacity:.5;cursor:default}
  .cancel{font:inherit;font-weight:600;padding:6px 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:#e5616a;cursor:pointer}
  .bar{display:flex;align-items:center;gap:12px;margin:14px 0}
  #status,#elapsed,#selcount{color:var(--mut);font-variant-numeric:tabular-nums}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 14px;margin-bottom:10px}
  .row{display:flex;align-items:center;gap:9px}.title{font-weight:600;flex:1}
  .timer{color:var(--mut);font-size:12px}.act{color:var(--mut);font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .act.stall{color:#e3b341}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--mut);opacity:.5;flex:none}
  [data-state=running] .dot{background:#e3b341;opacity:1;animation:pulse 1s infinite}
  [data-state=done] .dot{background:var(--g);opacity:1}[data-state=error] .dot{background:#e5616a;opacity:1}
  @keyframes pulse{50%{opacity:.35}}
  .note{color:var(--mut);font-size:11px;margin:0 0 12px}
  .finding{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:9px 12px;margin-bottom:8px}
  .badge{font-size:10px;padding:1px 7px;border-radius:20px;text-transform:uppercase;font-weight:700}
  .failure{background:rgba(248,81,73,.18);color:#ff7b72}.warning{background:rgba(210,153,34,.18);color:#e3b341}.notice{background:rgba(88,166,255,.18);color:#6cb6ff}
  .loc{color:var(--g2);font-size:12px;font-weight:500}.cm{display:block;margin-top:3px;color:var(--ink)}
  .hidden{display:none}a{color:var(--g2)}
</style></head><body${themeAttr}>
<div class="brand">${LOGO_SVG} MacroDeploy</div>
<div class="sub">Code Audit · running locally on your machine</div>
<div class="meta">
  <div>Repo <b id="repolabel">${esc(opts.repo)}</b> · Credential <b id="credlabel">${esc(opts.credentialLabel)}</b></div>
  <div id="notes">${(opts.notes ?? []).map((n) => `<div class="warn">⚠ ${esc(n)}</div>`).join("")}</div>
</div>

<div id="selector">
  <details class="settings">
    <summary>Settings</summary>
    <div class="srow"><label>Folder</label><span id="foldercur" style="flex:1;color:var(--ink)">${esc(opts.repo)}</span><button class="linkbtn" id="pickFolder">Change…</button></div>
    <div class="srow"><label>Credential</label>${sel("set-credential", s.credential, [["auto", "Auto (key if set, else subscription)"], ["apiKey", "Anthropic API key"], ["subscription", "Claude subscription"]])}</div>
    <div class="srow"><label>Worker model</label>${modelSel("set-workerModel", s.workerModel)}</div>
    <div class="srow"><label>Synth model</label>${modelSel("set-synthModel", s.synthModel)}</div>
    <div class="srow"><label>Theme</label>${sel("set-theme", s.theme, [["dark", "Dark"], ["light", "Light"], ["auto", "Follow editor"]])}</div>
  </details>

  <div class="selhead"><h3 style="margin:0">Choose audits</h3>
    <span><button class="linkbtn" id="all">Select all</button> · <button class="linkbtn" id="none">Clear</button></span></div>
  <div id="groups"></div>
  <div class="bar"><button class="primary" id="run">Run Code Audit</button><span id="selcount"></span></div>
</div>

<div id="progress" class="hidden">
  <div class="bar"><button class="cancel" id="cancel">Cancel</button>
    <button class="primary hidden" id="newaudit">＋ New audit</button>
    <a class="primary hidden" id="viewreport" href="#" style="text-decoration:none">View on MacroDeploy ↗</a>
    <span id="elapsed">0:00</span><span id="status">starting…</span></div>
  <div class="note">Each subagent reads files as needed (capped at 10 min). A long pause is usually a rate-limit wait — the timer keeps ticking, it isn't frozen.</div>
  <div id="cards"></div>
  <div id="reportWrap" class="hidden"><div id="report" class="meta"></div></div>
  <div id="findingsWrap" class="hidden"><h3 id="fhead">Findings</h3><div id="findings"></div></div>
</div>

<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const CATS=${cats};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
// ---- settings ----
function bindSetting(id,key){const el=document.getElementById(id);el.addEventListener('change',()=>{
  vscode.postMessage({type:'setting',key,value:el.value});
  if(key==='theme'){if(el.value==='auto')document.body.removeAttribute('data-theme');else document.body.setAttribute('data-theme',el.value);}});}
bindSetting('set-credential','credential');bindSetting('set-workerModel','workerModel');
bindSetting('set-synthModel','synthModel');bindSetting('set-theme','theme');
document.getElementById('pickFolder').onclick=()=>vscode.postMessage({type:'pickFolder'});
// ---- selection (expandable groups) ----
const groupsEl=document.getElementById('groups');
groupsEl.innerHTML=CATS.map(c=>'<div class="grp" data-cat="'+c.key+'"><div class="grphead"><input type="checkbox" class="grpck" data-cat="'+c.key+'"'+(c.on?' checked':'')+'><span class="caret">▸</span><span class="t">'+esc(c.title)+'</span><span class="cnt"></span></div><div class="items hidden">'+c.items.map(it=>'<label><input type="checkbox" data-cat="'+c.key+'" data-item="'+it.key+'"'+(c.on?' checked':'')+'> '+esc(it.label)+'</label>').join('')+'</div></div>').join('');
function catItems(k){return [...groupsEl.querySelectorAll('input[data-cat="'+k+'"][data-item]')];}
function refreshGroup(k){const its=catItems(k);const on=its.filter(i=>i.checked).length;const head=groupsEl.querySelector('.grpck[data-cat="'+k+'"]');
  head.checked=on>0;head.indeterminate=on>0&&on<its.length;
  groupsEl.querySelector('.grp[data-cat="'+k+'"] .cnt').textContent=on+'/'+its.length;}
function refreshAll(){let total=0;CATS.forEach(c=>{refreshGroup(c.key);total+=catItems(c.key).filter(i=>i.checked).length;});
  document.getElementById('selcount').textContent=total+' check'+(total===1?'':'s')+' selected';document.getElementById('run').disabled=total===0;}
groupsEl.addEventListener('change',e=>{const t=e.target;
  if(t.classList.contains('grpck')){const k=t.getAttribute('data-cat');catItems(k).forEach(i=>i.checked=t.checked);}
  refreshAll();});
groupsEl.addEventListener('click',e=>{const h=e.target.closest('.grphead');if(!h||e.target.classList.contains('grpck'))return;
  const grp=h.parentElement;grp.classList.toggle('open');grp.querySelector('.items').classList.toggle('hidden');});
document.getElementById('all').onclick=()=>{groupsEl.querySelectorAll('input[type=checkbox]').forEach(i=>i.checked=true);refreshAll();};
document.getElementById('none').onclick=()=>{groupsEl.querySelectorAll('input[type=checkbox]').forEach(i=>i.checked=false);refreshAll();};
refreshAll();
const titleOf={};CATS.forEach(c=>titleOf[c.key]=c.title);
document.getElementById('run').onclick=()=>{
  const selection={};CATS.forEach(c=>{const ks=catItems(c.key).filter(i=>i.checked).map(i=>i.getAttribute('data-item'));if(ks.length)selection[c.key]=ks;});
  const keys=Object.keys(selection);if(!keys.length)return;
  document.getElementById('cards').innerHTML=keys.map(k=>'<div class="card" id="card-'+k+'" data-state="pending"><div class="row"><span class="dot"></span><span class="title">'+esc(titleOf[k])+'</span><span class="timer" data-key="'+k+'"></span></div><div class="act" id="act-'+k+'">queued…</div></div>').join('');
  document.getElementById('selector').classList.add('hidden');document.getElementById('progress').classList.remove('hidden');
  document.getElementById('status').textContent='running '+keys.length+' subagent'+(keys.length>1?'s':'')+'…';
  startTimer();
  vscode.postMessage({type:'run',selection});
};
// ---- progress ----
let t0=0;const starts={};const acted={};let tick=null;
function fmt(ms){const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function startTimer(){t0=Date.now();if(tick)clearInterval(tick);tick=setInterval(()=>{
  document.getElementById('elapsed').textContent=fmt(Date.now()-t0);
  for(const k in starts){const el=document.querySelector('.timer[data-key="'+k+'"]');if(el&&starts[k]){el.textContent=fmt(Date.now()-starts[k]);
    if(!acted[k]&&Date.now()-starts[k]>20000){const a=document.getElementById('act-'+k);if(a){a.classList.add('stall');a.textContent='⏳ waiting on the model — likely a rate-limit pause (still running)';}}}}
},250);}
function stopTimer(){if(tick){clearInterval(tick);tick=null;}for(const k in starts)delete starts[k];}
function showDone(){stopTimer();document.getElementById('cancel').classList.add('hidden');document.getElementById('newaudit').classList.remove('hidden');}
function backToSelector(){stopTimer();for(const k in acted)delete acted[k];lastFindings=[];
  document.getElementById('progress').classList.add('hidden');document.getElementById('cards').innerHTML='';
  document.getElementById('findingsWrap').classList.add('hidden');document.getElementById('reportWrap').classList.add('hidden');
  document.getElementById('newaudit').classList.add('hidden');document.getElementById('viewreport').classList.add('hidden');
  document.getElementById('cancel').classList.remove('hidden');document.getElementById('elapsed').textContent='0:00';
  document.getElementById('selector').classList.remove('hidden');}
document.getElementById('newaudit').onclick=backToSelector;
document.getElementById('cancel').onclick=()=>{vscode.postMessage({type:'cancel'});stopTimer();
  document.getElementById('status').textContent='cancelled';
  document.querySelectorAll('.card[data-state="running"]').forEach(c=>{c.setAttribute('data-state','error');const a=c.querySelector('.act');if(a){a.classList.remove('stall');a.textContent='cancelled';}});
  showDone();};
function setState(k,st){const c=document.getElementById('card-'+k);if(c)c.setAttribute('data-state',st);}
let lastFindings=[];
function renderFindings(list){lastFindings=list;document.getElementById('fhead').textContent='Findings ('+list.length+')';document.getElementById('findingsWrap').classList.remove('hidden');
  document.getElementById('findings').innerHTML=list.map(x=>'<div class="finding"><span class="badge '+esc(x.level)+'">'+esc(x.level)+'</span> <span class="loc">'+esc(x.category)+' — '+esc(x.path)+':'+esc(x.line)+'</span><span class="cm">'+esc(x.comment)+'</span></div>').join('')||'<div class="note">No issues found. 🎉</div>';}
function renderReport(u){const c={failure:0,warning:0,notice:0};for(const f of lastFindings){const l=(f.level==='failure'||f.level==='warning'||f.level==='notice')?f.level:'warning';c[l]++;}
  const b=(n,cls,lbl)=>n?'<span class="badge '+cls+'">'+n+' '+lbl+'</span> ':'';
  let h='<div>'+b(c.failure,'failure','failure')+b(c.warning,'warning','warning')+b(c.notice,'notice','notice')+(lastFindings.length?'':'<b>Clean — no issues found.</b>')+'</div>';
  if(u)h+='<div style="margin-top:8px"><a href="'+esc(u)+'" style="font-weight:600;text-decoration:none">View full report on MacroDeploy ↗</a></div>';
  else if(u===null)h+='<div class="warn" style="margin-top:8px">Not saved — connect your account to keep a history (MacroDeploy: Connect).</div>';
  document.getElementById('report').innerHTML=h;document.getElementById('reportWrap').classList.remove('hidden');}
window.addEventListener('message',ev=>{const m=ev.data;
  if(m.type==='credlabel'){document.getElementById('credlabel').textContent=m.label;}
  else if(m.type==='target'){document.getElementById('foldercur').textContent=m.path;document.getElementById('repolabel').textContent=m.path;}
  else if(m.type==='category-start'){starts[m.key]=Date.now();setState(m.key,'running');const a=document.getElementById('act-'+m.key);if(a){a.classList.remove('stall');a.textContent='launching…';}}
  else if(m.type==='category-activity'){acted[m.key]=true;const a=document.getElementById('act-'+m.key);if(a){a.classList.remove('stall');a.textContent=m.message;}}
  else if(m.type==='category-done'){delete starts[m.key];setState(m.key,'done');const a=document.getElementById('act-'+m.key);if(a){a.classList.remove('stall');a.textContent=m.count+' finding(s)';}}
  else if(m.type==='category-error'){delete starts[m.key];setState(m.key,'error');const a=document.getElementById('act-'+m.key);if(a){a.classList.remove('stall');a.textContent='failed: '+m.message;}}
  else if(m.type==='findings'){renderFindings(m.findings);renderReport(undefined);document.getElementById('status').textContent='complete · '+m.findings.length+' finding(s) · saving…';}
  else if(m.type==='saved'){renderReport(m.url);showDone();
    if(m.url){const v=document.getElementById('viewreport');v.href=m.url;v.classList.remove('hidden');document.getElementById('status').textContent='complete · saved to macrodeploy.com/audits';}
    else{document.getElementById('status').textContent='complete · '+lastFindings.length+' finding(s) (not saved)';}}
  else if(m.type==='fatal'){showDone();document.getElementById('status').textContent='error: '+m.message;}
});
</script></body></html>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m] as string));
}
