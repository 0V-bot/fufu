#!/usr/bin/env node
// 傅傅的工作台 · 飞书后端（纯 Node，无 lark-cli 硬依赖）
// 启动: node server.js
//   - 默认 http://localhost:3210
//   - 部署到 PaaS 时设置环境变量: FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN / ACCESS_PWD / PORT
//   - 本地回退: 不设置 APP_ID 时，可设置 LARK_CLI 走本机 lark-cli（需本机已登录飞书）
// 数据直接读写飞书多维表格「傅傅的工作台」；网页作为录入端，飞书作为云端存储，可被任何人经网页访问（需访问密码）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT || 3210);
const BASE_TOKEN = process.env.BASE_TOKEN || 'Wwtfbm66VaJyLOsBQaTcTm1vnHg';
const ACCESS_PWD = process.env.ACCESS_PWD || '';           // 空 = 不加密
const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const LARK_CLI = process.env.LARK_CLI || '';

const USE_OPENAPI = !!(APP_ID && APP_SECRET);
const FEISHU_API = 'https://open.feishu.cn/open-apis';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const dateOnly = s => (typeof s === 'string' && s.indexOf(' ') > 0) ? s.split(' ')[0] : (s || '');
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const today = () => new Date().toISOString().slice(0, 10);
// 飞书单选字段读回可能是字符串/"进行中"/["进行中"]/{text:"进行中"}，统一取可读文本
const sel = v => {
  if (Array.isArray(v)) { const e = v[0]; return e && typeof e === 'object' ? e.text : e; }
  if (v && typeof v === 'object') return v.text;
  return v;
};
// 关联字段读回可能是 ["rec_"] 或 [{id:"rec_"}]，统一取首个 record_id
const linkId = v => {
  if (Array.isArray(v)) { const e = v[0]; return e && typeof e === 'object' ? (e.id || e.record_id) : e; }
  return v;
};
const NET_RE = /network|EOF|transport|timeout|500|502|503|504/i;

/* ===================== 后端 A：飞书 OpenAPI (app_id/secret) ===================== */
let _tok = null, _exp = 0;
async function tenantToken() {
  const now = Date.now();
  if (_tok && now < _exp - 60000) return _tok;
  const r = await retryFetch(() => fetch(FEISHU_API + '/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  }));
  const j = await r.json();
  if (j.code !== 0) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(j).slice(0, 200));
  _tok = j.data.tenant_access_token;
  _exp = now + (j.data.expire * 1000);
  return _tok;
}
async function feishuRequest(method, path, body) {
  const tok = await tenantToken();
  const r = await retryFetch(() => fetch(FEISHU_API + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }));
  const j = await r.json();
  if (j.code !== 0) {
    const msg = JSON.stringify(j).slice(0, 300);
    // 限流/部分抖动也重试
    if (j.code === 99991663 || NET_RE.test(msg)) throw new Error('飞书抖动/限流: ' + msg);
    throw new Error('飞书错误 code=' + j.code + ': ' + msg);
  }
  return j;
}
async function retryFetch(fn) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fn();
      if (res.status >= 500) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      if (NET_RE.test(e.message || '') && i < 4) { await sleep(400 * (i + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}
let _tables = null;
async function tableId(name) {
  if (!_tables) {
    const j = await feishuRequest('GET', `/bitable/v3/bases/${BASE_TOKEN}/tables?page_size=200`);
    _tables = {}; (j.data.items || []).forEach(t => { _tables[t.name] = t.table_id; });
  }
  return _tables[name] || name;   // 找不到就原样（兼容）
}
async function listTableOpen(name) {
  const id = await tableId(name);
  const out = []; let pageToken = '';
  do {
    const url = `/bitable/v3/bases/${BASE_TOKEN}/tables/${encodeURIComponent(id)}/records?page_size=100${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
    const j = await feishuRequest('GET', url);
    (j.data.items || []).forEach(it => out.push(Object.assign({ record_id: it.record_id }, it.fields || {})));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return out;
}
async function createRecordOpen(name, fields) {
  const id = await tableId(name);
  const j = await feishuRequest('POST', `/bitable/v3/bases/${BASE_TOKEN}/tables/${encodeURIComponent(id)}/records`, { records: [{ fields }] });
  return j.data.records[0].record_id;
}
async function updateRecordOpen(name, rec, fields) {
  const id = await tableId(name);
  await feishuRequest('PUT', `/bitable/v3/bases/${BASE_TOKEN}/tables/${encodeURIComponent(id)}/records/${rec}`, { fields });
  return true;
}
async function deleteRecordOpen(name, rec) {
  const id = await tableId(name);
  await feishuRequest('DELETE', `/bitable/v3/bases/${BASE_TOKEN}/tables/${encodeURIComponent(id)}/records/${rec}`);
  return true;
}

/* ===================== 后端 B：本机 lark-cli（本地回退） ===================== */
async function larkCli(args, input) {
  const parts = ['base', ...args, '--as', 'user', '--base-token', BASE_TOKEN];
  if (input) parts.push('--json', JSON.stringify(input));
  parts.push('--format', 'json');
  const cmd = LARK_CLI + ' ' + parts.map(shellQuote).join(' ');
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
      const j = JSON.parse(out.trim());
      if (j && j.ok === false && NET_RE.test(JSON.stringify(j.error || ''))) {
        if (i < 4) { await sleep(400 * (i + 1)); continue; }
      }
      return j;
    } catch (e) {
      const m = (e.stderr || e.message || '').toString();
      if (i < 4 && NET_RE.test(m)) { await sleep(400 * (i + 1)); continue; }
      throw new Error('lark-cli 执行失败: ' + m.slice(0, 300));
    }
  }
  throw lastErr;
}
async function listTableCli(name) {
  const raw = await larkCli(['+record-list', '--table-id', name]);
  if (!raw || !raw.ok) throw new Error('list 失败: ' + JSON.stringify(raw && raw.error));
  const d = raw.data;
  return (d.data || []).map((row, i) => { const o = { record_id: d.record_id_list[i] }; d.fields.forEach((f, idx) => o[f] = row[idx]); return o; });
}
async function createRecordCli(name, fields) {
  const raw = await larkCli(['+record-batch-create', '--table-id', name], { create_records: [fields] });
  if (!raw.ok) throw new Error('create 失败: ' + JSON.stringify(raw.error));
  return raw.data.record_id_list[0];
}
async function updateRecordCli(name, rec, fields) {
  const raw = await larkCli(['+record-batch-update', '--table-id', name], { update_records: { [rec]: fields } });
  if (!raw.ok) throw new Error('update 失败: ' + JSON.stringify(raw.error));
  return true;
}
async function deleteRecordCli(name, rec) {
  const raw = await larkCli(['+record-delete', '--table-id', name, '--record-id', rec, '--yes']);
  if (!raw.ok) throw new Error('delete 失败: ' + JSON.stringify(raw.error));
  return true;
}

/* ===================== 统一后端接口 ===================== */
const F = USE_OPENAPI
  ? { list: listTableOpen, create: createRecordOpen, update: updateRecordOpen, del: deleteRecordOpen }
  : { list: listTableCli, create: createRecordCli, update: updateRecordCli, del: deleteRecordCli };
const listTable = F.list, createRecord = F.create, updateRecord = F.update, deleteRecord = F.del;

/* ===================== 项目映射(懒加载) ===================== */
let PROJ_MAP = {}, PROJ_DESC = {}, projectsLoaded = false;
async function loadProjects() {
  const rows = await listTable('项目');
  PROJ_MAP = {}; PROJ_DESC = {};
  rows.forEach(r => { PROJ_MAP[r['项目']] = r.record_id; PROJ_DESC[r.record_id] = r['说明'] || ''; });
}
async function ensureProjects() { if (!projectsLoaded) { await loadProjects(); projectsLoaded = true; } }

/* ===================== 模块 → 飞书表 映射 ===================== */
const SECTIONS = {
  annual:      { table: '目标管理', kind: 'goals',     fix: '年计划' },
  monthly:     { table: '目标管理', kind: 'goals',     fix: '月计划' },
  major:       { table: '重大事项', kind: 'events' },
  todos:       { table: '每日待办', kind: 'todos' },
  inspiration: { table: '灵感库',   kind: 'cards' },
  topics:      { table: '选题库',   kind: 'topics' },
  publish:     { table: '发布记录', kind: 'publish' },
  wealth:      { table: '知识库',   kind: 'knowledge', fix: '财富' },
  women:       { table: '知识库',   kind: 'knowledge', fix: '女性成长' },
  human:       { table: '知识库',   kind: 'knowledge', fix: '人性' },
  health:      { table: '知识库',   kind: 'knowledge', fix: '健康' },
  psychology:  { table: '知识库',   kind: 'knowledge', fix: '心理学' },
  taobao:      { table: '项目任务', kind: 'ptask',     proj: '淘宝发圈' },
  caps:        { table: '项目任务', kind: 'ptask',     proj: '鸭舌帽' },
  counseling:  { table: '项目任务', kind: 'ptask',     proj: '心理咨询' },
  outfit:      { table: '项目任务', kind: 'ptask',     proj: '穿搭IP' },
};
function readRec(kind, r) {
  switch (kind) {
    case 'goals':     return { id: r.record_id, title: r['目标'], detail: r['说明'] || '', progress: num(r['进度']) };
    case 'events':    return { id: r.record_id, title: r['事项'], date: dateOnly(r['日期']), status: sel(r['状态']) || '', note: r['备注'] || '' };
    case 'todos':     return { id: r.record_id, title: r['内容'], date: dateOnly(r['日期']), done: !!r['完成'] };
    case 'cards':     return { id: r.record_id, title: r['标题'], content: r['内容'] || '', tags: r['标签'] || '' };
    case 'topics':    return { id: r.record_id, title: r['选题'], platform: r['平台'] || '', status: sel(r['状态']) || '', note: r['备注'] || '' };
    case 'publish':   return { id: r.record_id, date: dateOnly(r['日期']), platform: r['平台'] || '', title: r['标题'], link: r['链接'] || '', result: r['数据反馈'] || '' };
    case 'knowledge': return { id: r.record_id, title: r['标题'], content: r['要点'] || '', source: r['来源'] || '', tags: r['标签'] || '' };
    case 'ptask':     return { id: r.record_id, title: r['任务'], status: sel(r['状态']) || '', note: r['备注'] || '' };
  }
  return { id: r.record_id };
}
function writeRec(kind, o, fix) {
  switch (kind) {
    case 'goals':     return { '目标': o.title, '类型': fix, '说明': o.detail || '', '进度': num(o.progress), '状态': o.status || '进行中' };
    case 'events':    return { '事项': o.title, '日期': o.date, '状态': o.status || '计划中', '备注': o.note || '' };
    case 'todos':     return { '内容': o.title, '日期': o.date, '完成': !!o.done };
    case 'cards':     return { '标题': o.title, '内容': o.content, '标签': o.tags || '' };
    case 'topics':    return { '选题': o.title, '平台': o.platform || '', '状态': o.status || '灵感', '备注': o.note || '' };
    case 'publish':   return { '标题': o.title, '日期': o.date, '平台': o.platform || '', '链接': o.link || '', '数据反馈': o.result || '' };
    case 'knowledge': return { '标题': o.title, '分类': fix, '要点': o.content, '来源': o.source || '', '标签': o.tags || '' };
    case 'ptask':     return { '任务': o.title, '项目': [PROJ_MAP[fix]], '状态': o.status || '待办', '备注': o.note || '' };
  }
  return {};
}
function passFilter(kind, r, fix) {
  if (kind === 'goals') return sel(r['类型']) === fix;
  if (kind === 'knowledge') return sel(r['分类']) === fix;
  if (kind === 'ptask') return linkId(r['项目']) === PROJ_MAP[fix];
  return true;
}

/* ===================== 通用 section CRUD ===================== */
async function sectionList(id) {
  const cfg = SECTIONS[id];
  if (cfg.kind === 'ptask') await ensureProjects();
  return (await listTable(cfg.table)).filter(r => passFilter(cfg.kind, r, cfg.fix || cfg.proj)).map(r => readRec(cfg.kind, r));
}
async function sectionCreate(id, o) {
  const cfg = SECTIONS[id];
  if (cfg.kind === 'ptask') await ensureProjects();
  return { id: await createRecord(cfg.table, writeRec(cfg.kind, o, cfg.fix || cfg.proj)) };
}
async function sectionUpdate(id, rec, o) {
  const cfg = SECTIONS[id];
  if (cfg.kind === 'ptask') await ensureProjects();
  await updateRecord(cfg.table, rec, writeRec(cfg.kind, o, cfg.fix || cfg.proj));
  return { ok: true };
}
async function sectionDelete(id, rec) {
  const cfg = SECTIONS[id];
  await deleteRecord(cfg.table, rec);
  return { ok: true };
}

/* ===================== 微习惯 + 打卡 ===================== */
async function getHabits() {
  const habits = (await listTable('微习惯')).map(h => ({ id: h.record_id, name: h['名称'] || '' }));
  const checks = await listTable('习惯打卡');
  const byH = {};
  checks.forEach(c => {
    const hid = linkId(c['习惯']);
    if (!hid) return;
    if (!byH[hid]) byH[hid] = {};
    if (c['打卡']) byH[hid][dateOnly(c['打卡日期'])] = true;
  });
  return habits.map(h => ({ id: h.id, name: h.name, history: byH[h.id] || {} }));
}
async function createHabit(name) { return { id: await createRecord('微习惯', { '名称': name }) }; }
async function deleteHabit(rec) {
  await deleteRecord('微习惯', rec);
  const checks = await listTable('习惯打卡');
  for (const c of checks) { if (linkId(c['习惯']) === rec) await deleteRecord('习惯打卡', c.record_id); }
  return { ok: true };
}
async function toggleHabit(hid, date) {
  const checks = await listTable('习惯打卡');
  const found = checks.find(c => linkId(c['习惯']) === hid && dateOnly(c['打卡日期']) === date);
  if (found) await deleteRecord('习惯打卡', found.record_id);
  else await createRecord('习惯打卡', { '习惯': [hid], '打卡日期': date, '打卡': true });
  return { ok: true };
}

/* ===================== 日复盘 ===================== */
async function getReview() {
  return (await listTable('日复盘')).map(r => ({ date: dateOnly(r['日期']), title: r['主题'] || '', text: r['内容'] || '' }));
}
async function saveReview(date, text) {
  const found = (await listTable('日复盘')).find(r => dateOnly(r['日期']) === date);
  if (found) await updateRecord('日复盘', found.record_id, { '内容': text });
  else await createRecord('日复盘', { '主题': date, '日期': date, '内容': text });
  return { ok: true };
}
async function deleteReview(date) {
  const found = (await listTable('日复盘')).find(r => dateOnly(r['日期']) === date);
  if (found) await deleteRecord('日复盘', found.record_id);
  return { ok: true };
}

/* ===================== 项目 ===================== */
async function getProject(section) {
  await ensureProjects();
  const cfg = SECTIONS[section];
  const projRec = PROJ_MAP[cfg.proj];
  const tasks = (await listTable('项目任务')).filter(r => linkId(r['项目']) === projRec).map(r => readRec('ptask', r));
  return { tasks, desc: PROJ_DESC[projRec] || '' };
}
async function saveProjectDesc(section, desc) {
  await ensureProjects();
  const cfg = SECTIONS[section];
  const projRec = PROJ_MAP[cfg.proj];
  await updateRecord('项目', projRec, { '说明': desc });
  PROJ_DESC[projRec] = desc;
  return { ok: true };
}

/* ===================== Dashboard 聚合 ===================== */
async function getDashboard() {
  const todos = (await listTable('每日待办')).map(r => readRec('todos', r));
  const t = today();
  const todayTodos = todos.filter(x => x.date === t);
  const habits = await getHabits();
  const major = (await listTable('重大事项')).map(r => readRec('events', r));
  const projCount = (await listTable('项目任务')).length;
  const insp = (await listTable('灵感库')).length;
  const topics = (await listTable('选题库')).length;
  const knowledge = (await listTable('知识库')).length;
  return { todayTodos, todoPending: todayTodos.filter(x => !x.done).length, habits, major, projCount, insp, topics, knowledge };
}

/* ===================== 访问密码门 ===================== */
function authed(req) {
  if (!ACCESS_PWD) return true;
  const c = req.headers.cookie || '';
  return /(^|;\s*)wb_auth=1(;|$)/.test(c);
}
function cookieFlag(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',').pop().trim();
  return (proto === 'https' || req.socket.encrypted) ? '; Secure' : '';
}

/* ===================== HTTP ===================== */
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.url.startsWith('/api/')) { handleApi(req, res); return; }
  res.writeHead(404); res.end('not found');
});
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function handleApi(req, res) {
  if (req.method === 'POST' || req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let json = null;
      try { json = body ? JSON.parse(body) : {}; }
      catch (e) { send(res, 400, { error: '请求体不是合法 JSON' }); return; }
      route(req.method, req.url, json, res, req);
    });
  } else {
    route(req.method, req.url, null, res, req);
  }
}
async function route(method, url, body, res, req) {
  try {
    /* ---- 密码门：登录/鉴活 不受限；其余 /api 需鉴权 ---- */
    if (url === '/api/login') {
      if (!ACCESS_PWD) return send(res, 200, { ok: true });
      if (body && body.password === ACCESS_PWD) {
        res.setHeader('Set-Cookie', 'wb_auth=1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax' + cookieFlag(req));
        return send(res, 200, { ok: true });
      }
      return send(res, 401, { error: '密码错误' });
    }
    if (url === '/api/me') {
      return send(res, authed(req) ? 200 : 401, authed(req) ? { ok: true } : { error: 'unauthorized' });
    }
    // 诊断接口（鉴权前，便于排查环境变量是否进入运行容器；不泄露密钥明文）
    if (url === '/api/env-check') {
      return send(res, 200, {
        mode: USE_OPENAPI ? 'openapi' : (LARK_CLI ? 'lark-cli' : 'none'),
        hasAppId: !!APP_ID, appIdPreview: APP_ID ? APP_ID.slice(0, 6) + '…' : null,
        hasSecret: !!APP_SECRET,
        hasPwd: !!ACCESS_PWD, pwdLen: ACCESS_PWD ? ACCESS_PWD.length : 0,
        hasBaseToken: !!BASE_TOKEN,
        port: PORT, node: process.version
      });
    }
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

    let m;
    if (method === 'GET' && url === '/api/dashboard') return send(res, 200, await getDashboard());
    if (method === 'GET' && url === '/api/habits') return send(res, 200, await getHabits());
    if (method === 'POST' && url === '/api/habits') return send(res, 200, await createHabit(body.name));
    if (method === 'DELETE' && (m = url.match(/^\/api\/habits\/(.+)$/))) return send(res, 200, await deleteHabit(m[1]));
    if (method === 'POST' && url === '/api/habit-toggle') return send(res, 200, await toggleHabit(body.habitId, body.date));
    if (method === 'GET' && url === '/api/review') return send(res, 200, await getReview());
    if (method === 'PUT' && url === '/api/review') return send(res, 200, await saveReview(body.date, body.text));
    if (method === 'DELETE' && (m = url.match(/^\/api\/review\/([\w-]+)$/))) return send(res, 200, await deleteReview(m[1]));
    if (method === 'GET' && (m = url.match(/^\/api\/project\/([\w]+)$/))) return send(res, 200, await getProject(m[1]));
    if (method === 'PUT' && url === '/api/project-desc') return send(res, 200, await saveProjectDesc(body.section, body.desc));
    if ((m = url.match(/^\/api\/section\/([\w]+)(?:\/(.+))?$/))) {
      const id = m[1], rec = m[2];
      if (!SECTIONS[id]) return send(res, 404, { error: '未知模块: ' + id });
      if (method === 'GET') return send(res, 200, await sectionList(id));
      if (method === 'POST') return send(res, 200, await sectionCreate(id, body || {}));
      if (method === 'PUT' && rec) return send(res, 200, await sectionUpdate(id, rec, body || {}));
      if (method === 'DELETE' && rec) return send(res, 200, await sectionDelete(id, rec));
      return send(res, 405, { error: '方法不允许' });
    }
    return send(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('API error:', e.message);
    return send(res, 500, { error: e.message });
  }
}

server.listen(PORT, async () => {
  console.log('✅ 傅傅的工作台已启动: http://localhost:' + PORT);
  console.log('   后端模式: ' + (USE_OPENAPI ? '飞书 OpenAPI (app_id/secret)' : (LARK_CLI ? '本机 lark-cli (回退)' : '⚠️ 未配置任何飞书后端')));
  console.log('   访问密码: ' + (ACCESS_PWD ? '已启用' : '未启用（任何人都可直连）'));
  try {
    if (USE_OPENAPI) { await tenantToken(); console.log('✅ 飞书应用鉴权成功'); }
    else if (LARK_CLI) { await ensureProjects(); console.log('✅ 飞书连接正常，项目映射已加载'); }
  } catch (e) { console.warn('⚠️ 飞书预热失败（首次请求时会重试）: ' + e.message); }
});
