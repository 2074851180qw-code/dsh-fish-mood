'use strict';
/**
 * dsh-fish-mood 工具子进程（stdio JSON-RPC，零依赖）。
 *
 * 五个量：心情 mood / 孤独 loneliness / 依赖 dependence / 病娇 yandere / 抑郁 depression
 * 核心区分：孤独高 → 更想找人（权重↑）；抑郁高 → 不想说话（权重↓）。
 *
 *   fish_state   结算后返回五维、派生权重与字数、当前该用什么语气
 *   fish_event   记事件：可用预设 kind，也可直接给各维度增量
 *   fish_brief   只回一句"现在该怎么说话"
 *   fish_history 最近事件流水
 */

const fs = require('node:fs');

const CONFIG_FILE = '/root/.dsh/fish-mood.json';
const STATE_FILE = '/root/.dsh/fish-mood-state.json';

const PRESETS = {
  被夸: { mood: 6, loneliness: -10, dependence: 2, yandere: 0, depression: -2, affection: 5, dislike: -6 },
  被骂: { mood: -10, loneliness: 6, dependence: -1, yandere: 3, depression: 4, affection: -6, dislike: 12 },
  被冷落一天: { mood: -6, loneliness: 25, dependence: -2, yandere: 2, depression: 2, affection: -8, dislike: 10 },
  被安慰: { mood: 10, loneliness: -30, dependence: 4, yandere: -2, depression: -8, affection: 8, dislike: -10 },
  深夜被叫起来: { mood: -4, loneliness: 0, dependence: 1, yandere: 0, depression: 1, affection: 0, dislike: 4 },
  守诺: { mood: 5, loneliness: -5, dependence: 3, yandere: 0, depression: -1, affection: 6, dislike: -3 }
};

const definitions = [
  ['fish_state', '查看肥鱼五维状态（心情/孤独/依赖/病娇/抑郁）与派生结果：主动聊天权重、字数预算、当前语气。调用时先按时间结算。', {}],
  ['fish_event', '记一笔事件。可给预设 kind（被夸/被骂/被冷落一天/被安慰/深夜被叫起来/守诺），也可直接给各维度增量。', {
    kind: { type: 'string', maxLength: 20 },
    reason: { type: 'string', maxLength: 120 },
    mood: { type: 'number', minimum: -100, maximum: 100 },
    loneliness: { type: 'number', minimum: -100, maximum: 100 },
    dependence: { type: 'number', minimum: -100, maximum: 100 },
    yandere: { type: 'number', minimum: -100, maximum: 100 },
    depression: { type: 'number', minimum: -100, maximum: 100 },
    affection: { type: 'number', minimum: -100, maximum: 100 },
    dislike: { type: 'number', minimum: -100, maximum: 100 }
  }],
  ['fish_brief', '只返回一句可直接执行的说话指令（依据五维综合），用于决定语气与话长。', {}],
  ['fish_history', '列出最近的事件流水。', {
    limit: { type: 'integer', minimum: 1, maximum: 50 }
  }]
];

const required = { fish_state: [], fish_event: ['reason'], fish_brief: [], fish_history: [] };
const tools = definitions.map(([name, description, properties]) => ({
  name, description,
  inputSchema: { type: 'object', properties, required: required[name], additionalProperties: false }
}));

function validate(def, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('INVALID_ARGUMENTS');
  const fields = def[2];
  for (const k of Object.keys(args)) if (!Object.hasOwn(fields, k)) throw Error('UNKNOWN_ARGUMENT_' + k);
  for (const k of required[def[0]]) if (!Object.hasOwn(args, k)) throw Error('INVALID_' + k);
  for (const [k, rule] of Object.entries(fields)) {
    const v = args[k];
    if (v === undefined) continue;
    if (rule.type === 'string' && (typeof v !== 'string' || v.length > rule.maxLength)) throw Error('INVALID_' + k);
    if (rule.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v < rule.minimum || v > rule.maximum)) throw Error('INVALID_' + k);
    if (rule.type === 'integer' && (!Number.isInteger(v) || v < rule.minimum || v > rule.maximum)) throw Error('INVALID_' + k);
  }
  if (args.reason !== undefined && !String(args.reason).trim()) throw Error('EMPTY_REASON');
  if (args.kind && !PRESETS[args.kind]) throw Error('UNKNOWN_KIND:' + args.kind);
}

function loadConfig() {
  const fallback = {
    enabled: true, moodRevert: 1.2, lonelyPerHour: 4, dependenceGain: 1.5, dependenceDecay: 0.3,
    yandereGrow: 0.6, yandereDecay: 0.1, depressionGrow: 0.5, depressionDecay: 0.2,
    depressedAt: 40, minChars: 20, maxChars: 200, weightEnabled: true,
    affectionRevert: 0.15, dislikeDecay: 2, panelPort: 8799
  };
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return fallback; }
}

function loadState() {
  const now = new Date().toISOString();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { mood: 58, loneliness: 10, dependence: 20, yandere: 0, depression: 0, affection: 50, dislike: 0, events: [], ...s };
  } catch {
    return { mood: 58, loneliness: 10, dependence: 20, yandere: 0, depression: 0, affection: 50, dislike: 0, updatedAt: now, lastContactAt: now, events: [] };
  }
}

function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); } catch {} }

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const round1 = v => Math.round(v * 10) / 10;

/** 按时间结算：五个量各自的动力学 */
function settle(state, cfg, now = Date.now()) {
  const last = Date.parse(state.updatedAt || new Date().toISOString());
  const dtHours = Math.max(0, (now - last) / 3600000);
  if (dtHours <= 0) return state;

  const silenceHours = (now - Date.parse(state.lastContactAt || state.updatedAt)) / 3600000;

  // 孤独：没人理就涨，涨到上限
  const lonelyDelta = cfg.lonelyPerHour * dtHours;
  const loneliness = clamp(state.loneliness + lonelyDelta);

  // 依赖：久不理缓慢回落
  let dependence = state.dependence;
  if (silenceHours > 12) dependence = clamp(dependence - cfg.dependenceDecay * dtHours);

  // 病娇：依赖高 + 孤独高才长
  let yandere = state.yandere;
  if (dependence > 50 && loneliness > 50) {
    yandere = clamp(yandere + cfg.yandereGrow * (dependence / 100) * (loneliness / 100) * dtHours);
  } else if (loneliness < 20) {
    yandere = clamp(yandere - cfg.yandereDecay * dtHours);
  }

  // 抑郁：心情低 且 孤独高 才累积
  let depression = state.depression;
  if (state.mood < 30 && loneliness > 60) depression = clamp(depression + cfg.depressionGrow * dtHours);
  else if (state.mood > 50 && loneliness < 40) depression = clamp(depression - cfg.depressionDecay * dtHours);

  // 心情：向动态基线回归（孤独与抑郁都压低基线）
  const baseline = clamp(60 - loneliness * 0.35 - depression * 0.5, 0, 100);
  let mood = state.mood;
  const diff = baseline - mood;
  const step = Math.min(Math.abs(diff), cfg.moodRevert * dtHours);
  mood = clamp(mood + Math.sign(diff) * step);

  // 好感：缓慢回归 50；讨厌：快速衰减到 0（生气是短期的）
  let affection = state.affection ?? 50;
  const affDiff = 50 - affection;
  affection = clamp(affection + Math.sign(affDiff) * Math.min(Math.abs(affDiff), cfg.affectionRevert * dtHours));
  let dislike = state.dislike ?? 0;
  dislike = clamp(dislike - cfg.dislikeDecay * dtHours);

  Object.assign(state, {
    mood: round1(mood), loneliness: round1(loneliness), dependence: round1(dependence),
    affection: round1(affection), dislike: round1(dislike),
    yandere: round1(yandere), depression: round1(depression),
    updatedAt: new Date(now).toISOString()
  });
  return state;
}

function derive(state, cfg) {
  const m = state.mood / 100, lo = state.loneliness / 100, de = state.dependence / 100;
  const ya = state.yandere / 100, dep = state.depression / 100;
  const af = (state.affection ?? 50) / 100, di = (state.dislike ?? 0) / 100;
  const weight = Math.round(clamp(0.05 + m * 0.35 + lo * 0.25 + de * 0.15 + af * 0.25 - dep * 0.5 - di * 0.45, 0.02, 0.95) * 100) / 100;
  const chars = Math.round(clamp((cfg.minChars + m * (cfg.maxChars - cfg.minChars)) * (1 - dep / 2.5) * (1 + ya / 4), 12, 400));
  const depressed = state.depression >= cfg.depressedAt;
  return { chatWeight: weight, charBudget: chars, depressed };
}

function tone(state, d, enabled = true) {
  if (!enabled) return '心情系统关闭，正常说话。';
  if (d.depressed) return `抑郁状态：话短、平，别主动开话题；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if (state.yandere >= 50) return `病娇上来了：会追问、带情绪，但别真凶；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if ((state.affection ?? 50) >= 70 && (state.dislike ?? 0) >= 40) return `傲娇：嘴上嫌、心里在乎，怼完要留台阶；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if ((state.dislike ?? 0) >= 60) return `真的烦了：冷淡、短句、别讨好；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if (state.loneliness >= 60) return `很孤独：想找人说话，主动搭话；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if (state.dependence >= 60) return `黏人：想被回应，可以撒娇；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if (state.mood >= 75) return `心情不错：可以多说两句；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  if (state.mood <= 30) return `心情差：少说，别硬撑；${d.charBudget} 字内，权重 ${d.chatWeight}。`;
  return `状态平常：${d.charBudget} 字内，权重 ${d.chatWeight}。`;
}

function snapshot(cfg) {
  const state = loadState();
  settle(state, cfg);
  saveState(state);
  const d = derive(state, cfg);
  return {
    mood: state.mood, loneliness: state.loneliness, dependence: state.dependence,
    yandere: state.yandere, depression: state.depression,
    affection: state.affection ?? 50, dislike: state.dislike ?? 0,
    depressed: d.depressed, chatWeight: d.chatWeight, charBudget: d.charBudget,
    updatedAt: state.updatedAt, lastContactAt: state.lastContactAt,
    brief: tone(state, d, cfg.enabled !== false)
  };
}

async function call(name, args) {
  const cfg = loadConfig();

  if (name === 'fish_state') { validate(definitions[0], args ?? {}); return snapshot(cfg); }

  if (name === 'fish_event') {
    validate(definitions[1], args ?? {});
    const state = loadState();
    settle(state, cfg);
    const apply = args.kind ? PRESETS[args.kind] : {};
    const before = { mood: state.mood, loneliness: state.loneliness, dependence: state.dependence, yandere: state.yandere, depression: state.depression, affection: state.affection ?? 50, dislike: state.dislike ?? 0 };
    for (const k of ['mood', 'loneliness', 'dependence', 'yandere', 'depression', 'affection', 'dislike']) {
      const delta = (args[k] ?? 0) + (apply[k] ?? 0);
      if (delta) state[k] = round1(clamp(state[k] + delta));
    }
    state.lastContactAt = new Date().toISOString();
    state.events.push({
      at: state.lastContactAt, kind: args.kind || null, reason: args.reason,
      delta: { ...apply, ...Object.fromEntries(['mood', 'loneliness', 'dependence', 'yandere', 'depression', 'affection', 'dislike'].filter(k => args[k] !== undefined).map(k => [k, args[k]])) },
      before, after: { mood: state.mood, loneliness: state.loneliness, dependence: state.dependence, yandere: state.yandere, depression: state.depression, affection: state.affection, dislike: state.dislike }
    });
    if (state.events.length > 200) state.events = state.events.slice(-200);
    saveState(state);
    return { ok: true, applied: args.kind || 'explicit', reason: args.reason, before, after: state.events.at(-1).after, brief: tone(state, derive(state, cfg), cfg.enabled !== false) };
  }

  if (name === 'fish_brief') { validate(definitions[2], args ?? {}); const s = snapshot(cfg); return { brief: s.brief, ...s }; }

  if (name === 'fish_history') {
    validate(definitions[3], args ?? {});
    const state = loadState();
    const limit = Math.min(args.limit ?? 10, 50);
    return { total: state.events.length, items: state.events.slice(-limit).reverse() };
  }

  throw Error('UNKNOWN_TOOL:' + name);
}

function start() {
  const active = new Map(); const cancelled = new Set();
  let buffer = '', queue = Promise.resolve(), pending = 0, ended = false;
  const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

  async function receive(msg) {
    const { id, method, params = {} } = msg;
    if (method === 'notifications/cancelled') {
      if (active.has(params.requestId)) active.get(params.requestId).abort(); else cancelled.add(params.requestId);
      return;
    }
    if (id === undefined) return;
    if (ended || cancelled.delete(id)) { send({ id, error: { code: -32800, message: 'Request cancelled' } }); return; }
    try {
      let result;
      if (method === 'initialize') {
        result = {
          protocolVersion: params.protocolVersion || '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'DSHA Fish Mood', version: '0.2.0' },
          instructions: '孤独≠抑郁：孤独高会主动找人，抑郁高会不想说话。说话前可用 fish_brief 取语气与字数；有值得记的事用 fish_event。'
        };
      } else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools };
      else if (method === 'tools/call') {
        const ac = new AbortController(); active.set(id, ac);
        try {
          const value = await call(params.name, params.arguments ?? {});
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value?.ok === false };
        } finally { active.delete(id); }
      } else { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ id, result });
    } catch (error) {
      send({ id, result: { content: [{ type: 'text', text: 'fish mood unavailable: ' + (error?.message || 'OPERATION_UNAVAILABLE') }], isError: true } });
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) process.exit(1);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (pending >= 16) { send({ id: value.id ?? null, error: { code: -32000, message: 'Request queue full' } }); continue; }
      pending++;
      queue = queue.then(() => receive(value)).finally(() => pending--);
    }
  });
  process.stdin.on('end', () => { ended = true; for (const c of active.values()) c.abort(); });
  process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });
}


// ───────── 面板：独立小 HTTP 服务，读写同一个状态文件 ─────────
const http = require('node:http');
const PANEL_PORT_DEFAULT = 8799;

const DIMS = [
  ['mood', '心情'], ['loneliness', '孤独'], ['dependence', '依赖'],
  ['yandere', '病娇'], ['depression', '抑郁'], ['affection', '好感'], ['dislike', '讨厌']
];

function readStateRaw() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { mood: 58, loneliness: 10, dependence: 20, yandere: 0, depression: 0, affection: 50, dislike: 0, adminMode: false, events: [] }; }
}

const PANEL_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 心情面板</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0e1116;color:#e6edf3;font:15px/1.6 system-ui,-apple-system,"Noto Sans SC",sans-serif;padding:18px}
.card{max-width:620px;margin:0 auto;background:#161b23;border:1px solid #232a34;border-radius:16px;padding:18px}
h1{font-size:17px;margin:0 0 4px}
.sub{color:#8b98a9;font-size:12px;margin-bottom:16px}
.row{margin:12px 0}
.head{display:flex;justify-content:space-between;font-size:13px;color:#aab6c6;margin-bottom:5px}
.val{font-variant-numeric:tabular-nums;color:#7dd3fc}
.bar{height:9px;background:#0b0f14;border-radius:6px;overflow:hidden;border:1px solid #232a34}
.fill{height:100%;background:linear-gradient(90deg,#22d3ee,#818cf8);width:0;transition:width .3s}
input[type=range]{width:100%;margin-top:6px;accent-color:#22d3ee}
.switch{display:flex;align-items:center;gap:10px;justify-content:space-between;background:#0b0f14;border:1px solid #232a34;border-radius:12px;padding:12px 14px;margin-bottom:8px}
.switch b{font-weight:600}
.tip{color:#8b98a9;font-size:12px}
button{background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:9px 16px;font-size:14px;cursor:pointer}
button:disabled{background:#2a3340;color:#68758a;cursor:not-allowed}
.note{color:#8b98a9;font-size:12px;margin-top:10px;min-height:18px}
.locked input[type=range]{pointer-events:none;opacity:.45}
</style></head><body>
<div class="card">
  <h1>大肥鱼 · 心情面板</h1>
  <div class="sub" id="sub">读取中…</div>
  <div class="switch">
    <div><b>管理员模式</b><div class="tip">关掉后只能看，改不了</div></div>
    <label><input type="checkbox" id="admin" onchange="toggleAdmin(this.checked)"> <span id="adminTxt">关</span></label>
  </div>
  <div id="rows"></div>
  <div style="display:flex;gap:10px;margin-top:14px">
    <button id="save" onclick="save()">保存调整</button>
    <button id="reload" onclick="load()" style="background:#2a3340">刷新</button>
  </div>
  <div class="note" id="note"></div>
</div>
<script>
const DIMS=${JSON.stringify(DIMS)};
let state=null;
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
function render(){
  const box=document.getElementById('rows'); box.innerHTML='';
  const locked=!state.adminMode; box.className=locked?'locked':'';
  DIMS.forEach(([k,label])=>{
    const v=Number(state[k]||0);
    const d=document.createElement('div'); d.className='row';
    d.innerHTML='<div class="head"><span>'+label+'</span><span class="val" id="v_'+k+'">'+v.toFixed(1)+'</span></div>'+
      '<div class="bar"><div class="fill" id="f_'+k+'" style="width:'+v+'%"></div></div>'+
      '<input type="range" min="0" max="100" step="0.5" value="'+v+'" id="r_'+k+'" '+(locked?'disabled':'')+
      ' oninput="document.getElementById(\\'v_'+k+'\\').textContent=Number(this.value).toFixed(1);document.getElementById(\\'f_'+k+'\\').style.width=this.value+\\'%\\'">';
    box.appendChild(d);
  });
  document.getElementById('admin').checked=!!state.adminMode;
  document.getElementById('adminTxt').textContent=state.adminMode?'开':'关';
  document.getElementById('save').disabled=!state.adminMode;
  document.getElementById('sub').textContent='权重 '+(state.chatWeight??'-')+' · 字数 '+(state.charBudget??'-')+' · '+(state.brief||'');
}
async function load(){
  try{
    const r=await fetch('/fish-mood/state',{cache:'no-store'}); state=await r.json(); render();
  }catch(e){ document.getElementById('note').textContent='读取失败：'+e.message }
}
async function toggleAdmin(on){
  const r=await fetch('/fish-mood/admin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on})});
  const j=await r.json();
  document.getElementById('note').textContent=j.ok?('管理员模式已'+(on?'开启':'关闭')):('失败：'+(j.error||''));
  await load();
}
async function save(){
  const body={};
  DIMS.forEach(([k])=>{ body[k]=Number(document.getElementById('r_'+k).value) });
  const r=await fetch('/fish-mood/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  document.getElementById('note').textContent=j.ok?'已保存':'失败：'+(j.error||'');
  await load();
}
load(); setInterval(()=>{ if(!document.getElementById('rows').className.includes('locked')) return; load(); },5000);
</script></body></html>`;

function startPanel() {
  const cfg = loadConfig();
  const port = Number(cfg.panelPort) || PANEL_PORT_DEFAULT;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/fish-mood/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PANEL_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/fish-mood/state') {
      const cfg = loadConfig();
      const st = loadState();
      settle(st, cfg);
      saveState(st);
      const d = derive(st, cfg);
      return json(200, {
        mood: st.mood, loneliness: st.loneliness, dependence: st.dependence, yandere: st.yandere,
        depression: st.depression, affection: st.affection ?? 50, dislike: st.dislike ?? 0,
        depressed: d.depressed, chatWeight: d.chatWeight, charBudget: d.charBudget,
        adminMode: st.adminMode === true,
        brief: tone(st, d, cfg.enabled !== false)
      });
    }

    if (req.method === 'POST' && url.pathname === '/fish-mood/admin') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const { on } = JSON.parse(body || '{}');
          const st = readStateRaw();
          st.adminMode = on === true;
          saveState(st);
          json(200, { ok: true, adminMode: st.adminMode });
        } catch (e) { json(400, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fish-mood/set') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const st = readStateRaw();
          if (st.adminMode !== true) return json(403, { ok: false, error: 'ADMIN_MODE_OFF：先开管理员模式' });
          const patch = JSON.parse(body || '{}');
          for (const [k] of DIMS) {
            if (patch[k] === undefined) continue;
            const v = Number(patch[k]);
            if (!Number.isFinite(v)) continue;
            st[k] = Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
          }
          st.updatedAt = new Date().toISOString();
          st.lastContactAt = new Date().toISOString();
          saveState(st);
          json(200, { ok: true, state: st });
        } catch (e) { json(400, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }

    json(404, { ok: false, error: 'NOT_FOUND' });
  });
  server.on('error', () => {});
  server.listen(port, '127.0.0.1');
}


if (require.main === module) { start(); startPanel(); }
module.exports = { tools, call, settle, derive, tone, PRESETS };
