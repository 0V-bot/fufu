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
// 灵感库板块数据源：飞书多维表格「人生研究学院」的「人生灵感库」表
// 默认 Base/表如下；如需更换可走环境变量 INSPIRE_BASE_TOKEN / INSPIRE_TABLE 覆盖
const INSPIRE_BASE = process.env.INSPIRE_BASE_TOKEN || 'ARCcbggiUaFqESsV7pRcin8CnUb';
const INSPIRE_TABLE = process.env.INSPIRE_TABLE || 'tblpI6WqsvA5z0CL';
// 工作台「文章录入」先写入「录入表」，再由 life-wisdom-content-processor skill 分析后写入「人生灵感库」
const INPUT_TABLE = process.env.INPUT_TABLE || 'tblxVYnQ8P49qc6Y';
// 分类表（人生研究学院 Base 内）：详情编辑界面的「一级/二级/三级分类」级联下拉数据源
const CATEGORY_TABLE = process.env.CATEGORY_TABLE_TOKEN || 'tblfMizz0bw1juvw';
// 年计划/月计划 表格数据源：独立的「计划表格」Base 表，以 JSON 保存整个网格（含合并单元格）
const GRID_TABLE = process.env.GRID_TABLE || '计划表格';
const WISH_TABLE = process.env.WISH_TABLE || '愿望清单';
const INSP_TABLE = process.env.INSP_TABLE || '灵感记录';
const QUOTES_TABLE = process.env.QUOTES_TABLE || '金句摘抄';
const INSP_TYPE_TABLE = process.env.INSP_TYPE_TABLE || '灵感类型';
const INSP_TYPE_DEFAULTS = ['健康', '友情', '感情', '心理学', '女性成长', '时间管理', '精力管理', '职场', '情绪管理'];
const ACCESS_PWD = process.env.ACCESS_PWD || '';           // 空 = 不加密
const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const LARK_CLI = process.env.LARK_CLI || '';

const USE_OPENAPI = !!(APP_ID && APP_SECRET);
const FEISHU_API = 'https://open.feishu.cn/open-apis';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const dateOnly = s => {
  if (typeof s === 'number') { const d = new Date(s + 8 * 3600 * 1000), p = n => (n < 10 ? '0' + n : '' + n); return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()); }
  if (typeof s === 'string' && s.indexOf(' ') > 0) return s.split(' ')[0];
  return s || '';
};
// 飞书日期字段写入需毫秒时间戳数字（避免 DatetimeFieldConvFail）；纯日期补零时区转时间戳
// ⚠️ 空值必须返回 null（飞书允许"不填/清空"）；若返回 '' 空字符串会被拒收并导致整条写入失败(1254064)。
const toFeishuDate = s => {
  if (!s) return null;
  if (typeof s === 'number') return s;
  const ms = Date.parse(s.includes(' ') ? s : s + ' 00:00:00');
  return isNaN(ms) ? null : ms;   // 解析失败也返回 null，避免脏值让整条写入失败
};
// 截止时间等带时刻的字段：前端传来 "2026-08-02T14:30"（本地北京时间），
// 飞书 datetime 字段只接受 unix 毫秒（UTC 瞬时）。按北京时间(+8)换算成正确 UTC 毫秒，
// 这样飞书按用户时区回显就是用户输入的时刻，不会差 8 小时。
const toFeishuDateTime = s => {
  if (s === null || s === undefined || s === '') return null;   // 空值传 null，便于清空字段
  if (typeof s === 'number') {                                  // 已经是飞书回传的 UTC 毫秒，先转北京时间字符串
    const d = new Date(s + 8 * 3600 * 1000), p = n => (n < 10 ? '0' + n : '' + n);
    s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  const norm = String(s).replace('T', ' ').replace('Z', '').trim();
  const [dp, tp = '00:00'] = norm.split(' ');
  const p = dp.split('-').map(Number), q = tp.split(':').map(Number);
  if (p.length < 3) return null;
  return Date.UTC(p[0], p[1] - 1, p[2], q[0] || 0, q[1] || 0, 0) - 8 * 3600 * 1000;
};
// 飞书 datetime 字段读回的是 UTC 毫秒；转回北京时间 "YYYY-MM-DDTHH:MM" 供前端 datetime-local 显示
const fromFeishuDateTime = ms => {
  if (ms == null || ms === '') return '';
  const d = new Date(Number(ms) + 8 * 3600 * 1000), p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
// 统一按北京时间(东八区)计算"今天"，避免服务器 UTC 时区导致待办/复盘日期差一天
const today = () => { const d = new Date(Date.now() + 8 * 3600 * 1000), p = n => (n < 10 ? '0' + n : '' + n); return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()); };
// 飞书单选字段读回可能是字符串/"进行中"/["进行中"]/{text:"进行中"}，统一取可读文本
const sel = v => {
  if (Array.isArray(v)) { const e = v[0]; return e && typeof e === 'object' ? e.text : e; }
  if (v && typeof v === 'object') return v.text;
  return v;
};
// 关联字段读回格式多样：可能是 ["rec_"]、[{id:"rec_"}]，或飞书双向关联 [{record_ids:["rec_"],...}]，统一取首个 record_id
const linkId = v => {
  if (Array.isArray(v)) {
    const e = v[0];
    if (!e) return undefined;
    if (typeof e === 'object') return e.id || e.record_id || (e.record_ids && e.record_ids[0]);
    return e;
  }
  if (v && typeof v === 'object') return v.id || v.record_id || (v.record_ids && v.record_ids[0]);
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
  // 飞书内部 token 接口返回扁平结构 {code,msg,tenant_access_token,expire}，也可能带 data 包裹层，两种都兼容
  const tok = (j.data && j.data.tenant_access_token) || j.tenant_access_token;
  if (!tok) throw new Error('获取 tenant_access_token 响应异常(无 token): ' + JSON.stringify(j).slice(0, 200));
  _tok = tok;
  _exp = now + ((j.data && j.data.expire) || j.expire || 7200) * 1000;
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
    const msg = JSON.stringify(j).slice(0, 800);
    console.error('[feishu]', method, path, '=> code', j.code, msg);
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
// 飞书写接口的瞬时抖动/字段未就绪（建表后立即写记录偶发 1254001/1254607/1254291）重试
async function feishuRetry(fn, tries = 3, base = 900) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i < tries - 1 && /1254001|1254607|1254291|Data not ready|Write conflict|抖动/.test(e.message || '')) {
        await sleep(base * (i + 1)); continue;
      }
      throw e;
    }
  }
  throw last;
}
let _prefixCache = {};   // baseToken -> API 前缀
let _tableCache = {};    // baseToken -> { 表名: table_id }
// 探测正确的 API 前缀：传统多维表格用 v1/apps，新版 Base 用 v3/bases。两者都试，返回 code:0 的即为真路径。
// 按 baseToken 分别缓存，支持「主 Base + 灵感库独立 Base」并存。
async function basePrefix(baseToken = BASE_TOKEN) {
  if (_prefixCache[baseToken]) return _prefixCache[baseToken];
  for (const p of [`/bitable/v3/bases/${baseToken}`, `/bitable/v1/apps/${baseToken}`]) {
    try {
      const j = await feishuRequest('GET', p + '/tables?page_size=1');
      if (j.code === 0) { _prefixCache[baseToken] = p; return p; }
    } catch (e) { /* 路径不对会抛 JSON 解析异常(如 404 文本)，继续试下一个 */ }
  }
  _prefixCache[baseToken] = `/bitable/v1/apps/${baseToken}`; // 兜底（最常见形态）
  return _prefixCache[baseToken];
}
async function tableId(name, baseToken = BASE_TOKEN) {
  // 该表名不在缓存里时才重新拉取整表列表（否则直接用缓存；都查不到再回退原名）
  if (!_tableCache[baseToken] || !_tableCache[baseToken][name]) {
    const pre = await basePrefix(baseToken);
    const j = await feishuRequest('GET', `${pre}/tables?page_size=200`);
    _tableCache[baseToken] = _tableCache[baseToken] || {};
    (j.data.items || []).forEach(t => { _tableCache[baseToken][t.name] = t.table_id; });
  }
  return _tableCache[baseToken][name] || name;   // 找不到就原样（兼容；也可直接传 table_id）
}
async function listTableOpen(name, baseToken = BASE_TOKEN) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(name, baseToken);
  const out = []; let pageToken = '';
  do {
    const url = `${pre}/tables/${encodeURIComponent(id)}/records?page_size=100${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
    const j = await feishuRequest('GET', url);
    (j.data.items || []).forEach(it => out.push(Object.assign({ record_id: it.record_id }, it.fields || {})));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return out;
}
async function createRecordOpen(name, fields, baseToken = BASE_TOKEN) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(name, baseToken);
  // 单条记录创建：请求体顶层为 { fields }，响应在 data.record
  const j = await feishuRequest('POST', `${pre}/tables/${encodeURIComponent(id)}/records`, { fields });
  return j.data.record.record_id;
}
async function updateRecordOpen(name, rec, fields, baseToken = BASE_TOKEN) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(name, baseToken);
  await feishuRequest('PUT', `${pre}/tables/${encodeURIComponent(id)}/records/${rec}`, { fields });
  return true;
}
async function deleteRecordOpen(name, rec, baseToken = BASE_TOKEN) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(name, baseToken);
  await feishuRequest('DELETE', `${pre}/tables/${encodeURIComponent(id)}/records/${rec}`);
  return true;
}

/* ===================== 后端 B：本机 lark-cli（本地回退） ===================== */
async function larkCli(args, input, baseToken = BASE_TOKEN) {
  const parts = ['base', ...args, '--as', 'user', '--base-token', baseToken];
  // 注意：本机 Git Bash 经 `bash -c` 传递含中文的 --json 字符串会被破坏编码（mojibake）。
  // 因此把 JSON 写入临时文件，再用 `@./file` 传给 lark-cli，避免命令行中文乱码。
  let tmpFile = null;
  if (input) {
    tmpFile = '.lark_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.json';
    const ser = JSON.stringify(input);
    fs.writeFileSync(tmpFile, ser);
    parts.push('--json', '@./' + tmpFile);
  }
  parts.push('--format', 'json');
  const cmd = LARK_CLI + ' ' + parts.map(shellQuote).join(' ');
  let lastErr;
  try {
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
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) {} }
  }
}
async function listTableCli(name, baseToken = BASE_TOKEN) {
  const raw = await larkCli(['+record-list', '--table-id', name], null, baseToken);
  if (!raw || !raw.ok) throw new Error('list 失败: ' + JSON.stringify(raw && raw.error));
  const d = raw.data;
  return (d.data || []).map((row, i) => { const o = { record_id: d.record_id_list[i] }; d.fields.forEach((f, idx) => o[f] = row[idx]); return o; });
}
async function createRecordCli(name, fields, baseToken = BASE_TOKEN) {
  const raw = await larkCli(['+record-batch-create', '--table-id', name], { create_records: [fields] }, baseToken);
  if (!raw.ok) throw new Error('create 失败: ' + JSON.stringify(raw.error));
  return raw.data.record_id_list[0];
}
async function updateRecordCli(name, rec, fields, baseToken = BASE_TOKEN) {
  const raw = await larkCli(['+record-batch-update', '--table-id', name], { update_records: { [rec]: fields } }, baseToken);
  if (!raw.ok) throw new Error('update 失败: ' + JSON.stringify(raw.error));
  return true;
}
async function deleteRecordCli(name, rec, baseToken = BASE_TOKEN) {
  const raw = await larkCli(['+record-delete', '--table-id', name, '--record-id', rec, '--yes'], null, baseToken);
  if (!raw.ok) throw new Error('delete 失败: ' + JSON.stringify(raw.error));
  return true;
}

/* ===================== 统一后端接口 ===================== */
const F = USE_OPENAPI
  ? { list: listTableOpen, create: createRecordOpen, update: updateRecordOpen, del: deleteRecordOpen }
  : { list: listTableCli, create: createRecordCli, update: updateRecordCli, del: deleteRecordCli };
const listTable = F.list;
// 写入「项目任务」后立即失效短缓存，避免新建/编辑/删除后 5s 内仍显示旧数据（创建不显示 BUG）
function invalidateProjTasks() { _ptaskCache.ts = 0; _ptaskCache.data = null; }
const createRecord = async (name, fields, base) => { const r = await F.create(name, fields, base); if (name === '项目任务') invalidateProjTasks(); return r; };
const updateRecord = async (name, rec, fields, base) => { const r = await F.update(name, rec, fields, base); if (name === '项目任务') invalidateProjTasks(); return r; };
const deleteRecord = async (name, rec, base) => { const r = await F.del(name, rec, base); if (name === '项目任务') invalidateProjTasks(); return r; };

/* ===================== 项目映射(懒加载) ===================== */
let PROJ_MAP = {}, PROJ_DESC = {}, projectsLoaded = false;
async function loadProjects() {
  const rows = await listTable('项目');
  PROJ_MAP = {}; PROJ_DESC = {};
  rows.forEach(r => { PROJ_MAP[r['项目']] = r.record_id; PROJ_DESC[r.record_id] = r['说明'] || ''; });
}
async function ensureProjects() { if (!projectsLoaded) { await loadProjects(); projectsLoaded = true; } }

/* ===================== 模块 → 飞书表 映射 ===================== */
/* ===================== 年/月度计划表名常量（必须在 SECTIONS 之前声明，否则 TDZ 启动崩溃） ===================== */
const ANNUAL2_TABLE = process.env.ANNUAL2_TABLE || '年度计划';
const MONTHPLAN2_TABLE = process.env.MONTHPLAN2_TABLE || '月度计划';

const SECTIONS = {
  major:       { table: '重大事项', kind: 'events' },
  todos:       { table: '每日待办', kind: 'todos' },
  inspiration: { table: INSPIRE_TABLE, kind: 'wisdom', base: INSPIRE_BASE, readonly: true, allowDelete: true, allowEdit: true },
  topics:      { table: '选题库',   kind: 'topics' },
  publish:     { table: '发布记录', kind: 'publish' },
  // 知识库分类页：数据源是「人生灵感库」（真实带标签的文案资产都在这里），按 标签 字段筛选各自分类。
  // （早期曾用独立的「知识库」表，但用户的标签数据实际落在人生灵感库，故统一改读此处。）
  work:        { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '职场' },
  women:       { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '女性成长' },
  human:       { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '人性' },
  health:      { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '健康' },
  psychology:  { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '心理学' },
  emotion:     { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '情绪管理' },
  growth:      { table: INSPIRE_TABLE, base: INSPIRE_BASE, kind: 'knowledge', fix: '个人成长感悟' },
  taobao:      { table: '项目任务', kind: 'ptask',     proj: '淘宝发圈' },
  caps:        { table: '项目任务', kind: 'ptask',     proj: '鸭舌帽' },
  counseling:  { table: '项目任务', kind: 'ptask',     proj: '心理咨询' },
  outfit:      { table: '项目任务', kind: 'ptask',     proj: '穿搭IP' },
  bookcorner:  { table: '精神角落', kind: 'books' },
  wishes:      { table: WISH_TABLE, kind: 'wishes' },
  insprec:     { table: INSP_TABLE, kind: 'insprec' },
  quotes:      { table: QUOTES_TABLE, base: INSPIRE_BASE, kind: 'quotes' },
  calendar:    { table: '日程', kind: 'calendar' },
  // —— 以下模块纳入本地优先缓存 + 双向同步（此前走专用路由直连飞书，未走本地层）——
  annual2:     { table: ANNUAL2_TABLE, kind: 'annual2' },
  monthplan2:  { table: MONTHPLAN2_TABLE, kind: 'monthplan2' },
  review:      { table: '日复盘', kind: 'review' },
  diary:       { table: '日记', kind: 'diary' },
  habits:      { table: '微习惯', kind: 'habits' },
  habitChecks: { table: '习惯打卡', kind: 'habitCheck' },
  menstrual:   { table: '姨妈记录', kind: 'menstrual' },
  articleInput:{ table: INPUT_TABLE, base: INSPIRE_BASE, kind: 'article' }, // 录入表：接入本地优先缓存（首页 inputPending 改为读本地缓存）
};
// 人生灵感库 / 知识库分类页 富字段映射（两者同源「人生灵感库」表，结构完全一致）
function readInspireFields(r) {
  const multi = v => Array.isArray(v) ? v.map(x => x && typeof x === 'object' ? (x.text || x) : x).filter(Boolean) : [];
  const sl = r['来源链接']; const slText = sl && typeof sl === 'object' ? (sl.text || sl.link || '') : (sl || '');
  return {
    id: r.record_id,
    ID: r['ID'] || '',
    title: r['文案标题'] || '',
    cat1: sel(r['一级分类']) || '',
    cat2: sel(r['二级分类']) || '',
    cat3: sel(r['三级分类']) || '',
    tag: sel(r['标签']) || '',
    keywords: r['关键词'] || '',
    summary: r['AI总结'] || '',
    quote: r['金句提炼'] || '',
    original: r['原始文案'] || '',
    date: dateOnly(r['收藏日期']),
    abstract: r['AI搜索摘要'] || '',
    ctype: sel(r['内容类型']) || '',
    status: sel(r['是否整理']) || '',
    source: r['来源'] || '',
    sourceLink: slText,
    reflection: r['个人感悟'] || ''
  };
}
function readRec(kind, r) {
  switch (kind) {
    case 'goals':     return { id: r.record_id, title: r['目标'], detail: r['说明'] || '', progress: num(r['进度']) };
    case 'events':    return { id: r.record_id, title: r['事项'], date: dateOnly(r['日期']), status: sel(r['状态']) || '', note: r['备注'] || '' };
    case 'todos':     return { id: r.record_id, title: r['内容'], date: dateOnly(r['日期']), done: !!r['完成'], deadline: r['截止时间'] || '', note: r['备注'] || '' };
    case 'wishes':    return { id: r.record_id, title: r['内容'] || '', done: !!r['完成'], realized: r['实现时间'] || '' };
    case 'insprec':   return { id: r.record_id, content: r['内容'] || '', type: sel(r['类型']) || '', date: dateOnly(r['日期']) };
    case 'cards':     return { id: r.record_id, title: r['标题'], content: r['内容'] || '', tags: r['标签'] || '' };
    case 'wisdom':    return readInspireFields(r);
    case 'topics':    return { id: r.record_id, title: r['选题'], platform: r['平台'] || '', status: sel(r['状态']) || '', note: r['备注'] || '', used: !!r['已使用'] };
    case 'publish':   return { id: r.record_id, planTime: fromFeishuDateTime(r['计划发布时间']), title: r['标题'] || '', content: r['文案'] || '', note: r['备注'] || '' };
    // 知识库分类页与人生灵感库同源同结构，返回完整字段，供富详情弹窗展示/编辑
    case 'knowledge': return readInspireFields(r);
    case 'ptask':     return {
      id: r.record_id,
      tid: num(r['ID']),
      title: r['任务标题'] || r['任务'] || '',
      taskTitle: r['任务标题'] || '',
      parent: (r['上级任务标题'] || '').toString().trim(),
      deadline: dateOnly(r['截止时间']),
      daily: sel(r['每日']) || '是',
      status: sel(r['状态']) || '',
      note: r['备注'] || ''
    };
    case 'books':     return { id: r.record_id, title: r['书名'] || '', author: r['作者'] || '', category: sel(r['分类']) || '', status: sel(r['状态']) || '', core: r['书本核心内容'] || '', note: r['读后感'] || '', source: r['来源'] || '', link: r['链接'] || '', date: dateOnly(r['日期']) };
    case 'calendar':  return { id: r.record_id, date: dateOnly(r['日期']), title: r['标题'] || '', time: r['时间'] || '', note: r['备注'] || '', remind: !!r['提醒'] };
    case 'menstrual': return { id: r.record_id, date: dateOnly(r['日期']), flow: sel(r['流量']) || '', note: r['备注'] || '' };
    // 金句摘抄：内容 / 分类(文本) / 记录时间(本地创建时间，ms)，created 以本地缓存为准（pull 不覆盖）
    case 'quotes':    return { id: r.record_id, content: r['内容'] || '', category: r['分类'] || '', created: Number(r['记录时间']) || 0 };
    // —— 本地优先模块：前端友好字段（与服务端 readRec 同源，供本地缓存种子/同步拉取）——
    case 'annual2':   return { id: r.record_id, year: Number(r['年份']), type: sel(r['类型']) || '', cellColor: (r['格子颜色'] || '') || '#ffffff', text: (r['文案'] || ''), textColor: (r['文字颜色'] || '') || '#0f172a', sort: Number(r['排序']) || 0, done: !!r['完成标记'] };
    case 'monthplan2': return { id: r.record_id, year: Number(r['年份']), month: Number(r['月份']), seq: num(r['序号']), item: (r['计划事项'] || ''), content: (r['计划内容'] || ''), deadline: dateOnly(r['截止时间']), done: Number(r['完成标签']) ? 1 : 0, daily: !!r['每日'], created: Number(r['创建时间']) || 0 };
    case 'review':    return { id: r.record_id, date: dateOnly(r['日期']), title: r['主题'] || '', text: r['内容'] || '' };
    case 'diary':     return { id: r.record_id, date: dateOnly(r['日期']), weather: r['天气'] || '', mood: r['心情'] || '', content: r['内容'] || '' };
    case 'habits':    return { id: r.record_id, name: r['名称'] || '' };
    case 'habitCheck': return { id: r.record_id, habit: linkId(r['习惯']), date: dateOnly(r['打卡日期']), checked: !!r['打卡'] };
    // —— 录入表（文章录入）：读取「人生灵感库」Base 的「录入表」——
    case 'article':   return { id: r.record_id, title: r['文案标题'] || '', content: r['原始文案'] || '', source: r['来源'] || '', sourceLink: r['来源链接'] || '', reflection: r['个人感悟'] || '', cat1: sel(r['一级分类']) || '', cat2: sel(r['二级分类']) || '', cat3: sel(r['三级分类']) || '', tag: sel(r['标签']) || '', ctype: sel(r['内容类型']) || '', summary: r['AI总结'] || '', date: Number(r['录入日期']) || 0, multi: !!r['是否多篇'] };
  }
  return { id: r.record_id };
}
async function writeRec(kind, o, fix) {
  switch (kind) {
    case 'goals':     return { '目标': o.title, '类型': fix, '说明': o.detail || '', '进度': num(o.progress), '状态': o.status || '进行中' };
    case 'events':    return { '事项': o.title, '日期': toFeishuDate(o.date), '状态': o.status || '计划中', '备注': o.note || '' };
    case 'todos':     return { '内容': o.title, '日期': toFeishuDate(o.date), '完成': !!o.done, '截止时间': o.deadline ? toFeishuDateTime(o.deadline) : null, '备注': o.note || '' };
    case 'wishes': {
      const done = !!o.done;
      // 实现时若未指定时间则取当前；取消实现则清空时间
      const realized = done ? (o.realized ? toFeishuDateTime(o.realized) : toFeishuDateTime(new Date().toISOString().slice(0, 16).replace('T', ' '))) : null;
      return { '内容': o.title || '', '完成': done, '实现时间': realized };
    }
    case 'insprec':   return { '内容': o.content || '', '类型': o.type || '', '日期': o.date ? toFeishuDate(o.date) : toFeishuDate(new Date().toISOString().slice(0, 10)) };
    case 'cards':     return { '标题': o.title, '内容': o.content, '标签': o.tags || '' };
    case 'wisdom': {
      // 灵感库位于 INSPIRE_BASE（v1 路径）：单选/多选字段前端可能以 {text} 或 [{text}] 形式提交，
      // 这里统一拍平为字符串 / 字符串数组，避免 SingleSelectFieldConvFail。
      const flat = v => {
        if (v && typeof v === 'object' && !Array.isArray(v)) return (v.text !== undefined ? v.text : (v.name !== undefined ? v.name : v));
        if (Array.isArray(v)) return v.map(flat);
        return v;
      };
      const out = {};
      Object.keys(o || {}).forEach(k => { out[k] = flat(o[k]); });
      return out;
    }
    case 'topics':    return { '选题': o.title, '平台': o.platform || '', '状态': o.status || '灵感', '备注': o.note || '', '已使用': !!o.used };
    case 'publish':   return { '计划发布时间': toFeishuDateTime(o.planTime), '标题': o.title || '', '文案': o.content || '', '备注': o.note || '' };
    case 'calendar':  return { '日期': toFeishuDate(o.date), '标题': o.title || '', '时间': o.time || '', '备注': o.note || '', '提醒': !!o.remind };
    case 'menstrual': return { '日期': toFeishuDate(o.date), '流量': o.flow ? o.flow : null, '备注': o.note || '' };
    // 金句摘抄：分类为纯文本字段（允许自由新增分类），记录时间写本地 created(ms)
    case 'quotes':    return { '内容': o.content || '', '分类': o.category || '', '记录时间': o.created ? Number(o.created) : null };
    case 'knowledge': return { '文案标题': o.title, '标签': o.tags || '', '来源': o.source || '', 'AI总结': o.content || '' };
    case 'ptask': {
      const proj = PROJ_MAP[fix];
      // 自增 ID：编辑时保留原 ID，新建时取该项目下现有最大 ID + 1（飞书无原生自增字段，由代码维护）
      const tid = (o.tid != null && o.tid !== '') ? Number(o.tid) : await nextTaskId(proj);
      const daily = o.daily || '是';
      // 每日任务不设截止时间；非每日任务才写入截止时间（空则 null）
      const deadline = daily === '是' ? null : (o.deadline ? toFeishuDate(o.deadline) : null);
      return {
        'ID': tid,
        '项目': [proj],
        '任务标题': o.taskTitle || o.title || '',
        '上级任务标题': (o.parent || '').toString().trim(),   // 存父任务的 ID（按 ID 索引关联）
        '每日': daily,
        '截止时间': deadline,
        '状态': o.status || '待办',
        '备注': o.note || ''
      };
    }
    case 'books': {
      // 注意：单选字段（分类/状态）传空字符串会被飞书拒绝(not_found)，故空值不写入
      const f = { '书名': o.title, '作者': o.author || '', '状态': o.status || '想读', '书本核心内容': o.core || '', '读后感': o.note || '', '来源': o.source || '', '链接': o.link || '', '日期': toFeishuDate(o.date) };
      if (o.category && String(o.category).trim()) f['分类'] = String(o.category).trim();
      return f;
    }
    // —— 本地优先模块：前端友好字段 → 飞书中文键（与服务端 writeRec 同源）——
    case 'annual2':   return { '年份': Number(o.year), '类型': o.type, '格子颜色': o.cellColor || '#ffffff', '文案': o.text || '', '文字颜色': o.textColor || '#0f172a', '排序': Number(o.sort), '完成标记': !!o.done };
    case 'monthplan2': return { '年份': Number(o.year), '月份': Number(o.month), '序号': Number(o.seq), '计划事项': o.item || '', '计划内容': o.content || '', '截止时间': (o.deadline ? toFeishuDate(o.deadline) : null), '完成标签': o.done ? 1 : 0, '每日': !!o.daily, '创建时间': o.created ? Number(o.created) : null };
    case 'review':    return { '主题': o.title || o.date, '日期': toFeishuDate(o.date), '内容': o.text || '' };
    case 'diary':     return { '日期': toFeishuDate(o.date), '天气': o.weather || '', '心情': o.mood || '', '内容': o.content || '' };
    case 'habits':    return { '名称': o.name };
    case 'habitCheck': return { '习惯': [o.habit], '打卡日期': toFeishuDate(o.date), '打卡': !!o.checked };
    case 'article':   return { '文案标题': o.title || '', '原始文案': o.content || '', '来源': o.source || '', '来源链接': o.sourceLink || '', '个人感悟': o.reflection || '', '一级分类': o.cat1 || '', '二级分类': o.cat2 || '', '三级分类': o.cat3 || '', '标签': o.tag || '', '内容类型': o.ctype || '', 'AI总结': o.summary || '', '录入日期': o.date || null, '是否多篇': o.multi ? '1' : '0' };
  }
  return {};
}
function passFilter(kind, r, fix) {
  if (kind === 'goals') return sel(r['类型']) === fix;
  if (kind === 'knowledge') {
    // 知识库分类页：优先按「标签」字段筛选（职场/女性成长/…）；
    // 兜底：标签为空但「分类」匹配时也展示，避免历史记录（仅填了分类、未填标签）在改版后消失
    const tag = sel(r['标签']); const cat = sel(r['分类']);
    return tag === fix || (!tag && cat === fix);
  }
  if (kind === 'ptask') return linkId(r['项目']) === PROJ_MAP[fix];
  return true;
}

/* ===================== 通用 section CRUD ===================== */
// 灵感库类板块列表所需字段（列表只取这些轻量字段，避免整篇「原始文案」拖慢首屏；
// 单条详情接口再单独取全字段）。排序一律按「索引 ID(record_id) 倒序」判断最新。
const INSPIRE_LIST_FIELDS = ['ID', '文案标题', '一级分类', '二级分类', '三级分类', '分类', '标签', '内容类型', '金句提炼', 'AI总结', '关键词', '是否整理', '来源', '收藏日期'];
const _rawCache = {};   // `${base}::${table}` -> { ts, rows }（raw 记录，按 record_id 倒序）
async function getInspireRows(base, table) {
  const key = base + '::' + table;
  const now = Date.now();
  if (_rawCache[key] && now - _rawCache[key].ts < 60000) return _rawCache[key].rows;
  let rows;
  if (USE_OPENAPI) {
    try {
      const pre = await basePrefix(base);
      const tid = await tableId(table, base);
      const fn = encodeURIComponent(JSON.stringify({ field_names: INSPIRE_LIST_FIELDS }));
      rows = [];
      let pageToken = '';
      do {
        const url = `${pre}/tables/${encodeURIComponent(tid)}/records?page_size=100&field_names=${fn}${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
        const j = await feishuRequest('GET', url);
        (j.data.items || []).forEach(it => rows.push(Object.assign({ record_id: it.record_id }, it.fields || {})));
        pageToken = j.data.has_more ? j.data.page_token : '';
      } while (pageToken);
    } catch (e) { rows = await listTable(table, base); }   // field_names 不被支持时回退全量
  } else {
    rows = await listTable(table, base);
  }
  // 按索引 ID 倒序：ID 越大越新（飞书 record_id 单调递增），最新在前
  rows.sort((a, b) => (b.record_id || '').localeCompare(a.record_id || ''));
  _rawCache[key] = { ts: now, rows };
  return rows;
}
// 列表输出瘦身：只回传卡片展示所需的轻量字段
function slimInsp(it) {
  const keep = ['id', 'ID', 'title', 'cat1', 'cat2', 'cat3', 'tag', 'quote', 'summary', 'keywords', 'ctype', 'date', 'status', 'source'];
  const o = {};
  keep.forEach(k => { o[k] = it[k]; });
  return o;
}
// 服务端搜索：只匹配能代表「文章是什么」的字段（与前端收窄范围一致），避免正文噪音
function inspMatch(it, q) {
  if (!q) return true;
  const ql = q.toLowerCase();
  const hay = [it.title, it.keywords, it.quote, it.summary, it.tag, it.cat1, it.cat2, it.cat3].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(ql);
}
function inspFacet(list, key) {
  const s = new Set();
  list.forEach(it => { const v = it[key]; if (v) s.add(v); });
  return [...s];
}
async function sectionList(id, opts) {
  opts = opts || {};
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  if (cfg.kind === 'ptask') await ensureProjects();
  // 全量完整字段：供前端本地缓存种子与双向同步拉取（不做 slim/分页/facets）
  if (opts.full) {
    return (await listTable(cfg.table, base)).filter(r => passFilter(cfg.kind, r, cfg.fix || cfg.proj)).map(r => readRec(cfg.kind, r));
  }
  // 仅灵感库类板块(wisdom/knowledge)走服务端分页；其余板块数据量小，保持一次性返回数组
  if (cfg.kind !== 'wisdom' && cfg.kind !== 'knowledge') {
    return (await listTable(cfg.table, base)).filter(r => passFilter(cfg.kind, r, cfg.fix || cfg.proj)).map(r => readRec(cfg.kind, r));
  }
  const raw = await getInspireRows(base, cfg.table);
  let list = raw.filter(r => passFilter(cfg.kind, r, cfg.fix)).map(r => readRec(cfg.kind, r));
  const q = (opts.q || '').trim();
  if (q) list = list.filter(it => inspMatch(it, q));
  if (opts.cat1) list = list.filter(it => it.cat1 === opts.cat1);
  if (opts.cat2) list = list.filter(it => it.cat2 === opts.cat2);
  if (opts.tag) list = list.filter(it => it.tag === opts.tag);
  if (opts.ctype) list = list.filter(it => it.ctype === opts.ctype);
  if (opts.status) list = list.filter(it => it.status === opts.status);
  const total = list.length;
  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
  const page = Math.max(1, Number(opts.page) || 1);
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize).map(slimInsp);
  // 各下拉的可选项（基于当前板块全量，不受搜索/筛选影响，便于切换）
  const facets = { cat1: inspFacet(list, 'cat1'), cat2: inspFacet(list, 'cat2'), tag: inspFacet(list, 'tag'), ctype: inspFacet(list, 'ctype') };
  return { items, total, page, pageSize, hasMore: start + pageSize < total, facets };
}
// 单条完整记录（详情弹窗用，返回全字段）
async function sectionRecord(id, rec) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  const pre = await basePrefix(base);
  const tid = await tableId(cfg.table, base);
  const j = await feishuRequest('GET', `${pre}/tables/${encodeURIComponent(tid)}/records/${rec}`);
  const r = j.data && j.data.record;
  if (!r) return null;
  return readRec(cfg.kind, Object.assign({ record_id: r.record_id }, r.fields || {}));
}
function invalidateCache(cfg, base) { _rawCache[(cfg.base || base || BASE_TOKEN) + '::' + cfg.table] = null; }
// 年度计划写入前确保「类型」单选含「分组」选项；本会话只跑一次（幂等），避免逐条同步时反复 PUT。
let _annual2GroupEnsured = false;
async function ensureAnnual2GroupOptionOnce() {
  if (_annual2GroupEnsured) return;
  try { await ensureAnnual2GroupOption(); _annual2GroupEnsured = true; }
  catch (e) { console.warn('ensureAnnual2GroupOption 失败（重试于下次写入）:', e.message); _annual2GroupEnsured = false; }
}
// ---- 创建幂等去重：用客户端传来的 _cid 防止同步重试 / 飞书抖动 / 重复提交产生重复记录 ----
// 同一 _cid 重复提交（同一本地记录多次推送、或 UI 抖动导致的重复点击）直接返回已存在的记录 id，不再新建。
const CID_MAP_FILE = path.join(__dirname, '__cid_map.json');
let _cidMap = {};
try { _cidMap = JSON.parse(fs.readFileSync(CID_MAP_FILE, 'utf8') || '{}'); } catch (_) { _cidMap = {}; }
let _cidMapDirty = false;
function saveCidMap() { if (!_cidMapDirty) return; try { fs.writeFileSync(CID_MAP_FILE, JSON.stringify(_cidMap)); _cidMapDirty = false; } catch (_) {} }
(function pruneCidMap() { const cut = Date.now() - 30 * 86400000; let ch = false; for (const k of Object.keys(_cidMap)) { if (Date.now() - (_cidMap[k].ts || 0) > cut) { delete _cidMap[k]; ch = true; } } if (ch) _cidMapDirty = true; saveCidMap(); })();
async function dedupeCreateId(id, cid) {
  if (!cid) return null;
  const e = _cidMap[cid]; if (!e) return null;
  try { const rec = await sectionRecord(id, e.rid); if (rec) return e.rid; } catch (_) { /* 读回失败视为失效 */ }
  delete _cidMap[cid]; _cidMapDirty = true; saveCidMap(); return null;
}
function recordCid(cid, rid) { if (!cid) return; _cidMap[cid] = { rid, ts: Date.now() }; _cidMapDirty = true; saveCidMap(); }

async function sectionCreate(id, o) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  const cid = o && o._cid; if (o && cid) delete o._cid; // _cid 仅用于幂等去重，不写入飞书
  if (cfg.kind === 'ptask') {
    await ensureProjects();
    // 非「每日」任务必须设置截止时间（前端同样拦截，这里兜底）
    if ((o.daily || '是') !== '是' && !(o.deadline || '').trim()) {
      const e = new Error('非「每日」任务必须设置截止时间'); e.status = 400; throw e;
    }
  }
  if (cfg.kind === 'annual2') await ensureAnnual2GroupOptionOnce();
  // 幂等：同一 _cid 重复提交直接返回已存在记录，避免抖动/重试产生重复数据
  if (cid) { const existing = await dedupeCreateId(id, cid); if (existing) return { id: existing }; }
  const rid = await createRecord(cfg.table, await writeRec(cfg.kind, o, cfg.fix || cfg.proj), base);
  if (cid) recordCid(cid, rid);
  return { id: rid };
}
async function sectionUpdate(id, rec, o) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  if (cfg.kind === 'ptask') {
    await ensureProjects();
    // 读回现有记录，把未提供的字段用现有值补齐，避免「部分更新」（如改标题/状态/每日）
    // 把 ID(自增编号) / 上级任务标题(父编号) / 截止时间等覆盖成空或重新生成，导致父子关系丢失。
    const existing = await sectionRecord(id, rec);
    const merged = Object.assign({
      tid: existing ? existing.tid : undefined,
      taskTitle: existing ? existing.taskTitle : '',
      parent: existing ? existing.parent : '',
      daily: existing ? existing.daily : '是',
      deadline: existing ? existing.deadline : '',
      status: existing ? existing.status : '待办',
      note: existing ? existing.note : ''
    }, o);
    if ((merged.daily || '是') !== '是' && !(merged.deadline || '').trim()) {
      const e = new Error('非「每日」任务必须设置截止时间'); e.status = 400; throw e;
    }
    await updateRecord(cfg.table, rec, await writeRec(cfg.kind, merged, cfg.fix || cfg.proj), base);
    return { ok: true };
  }
  await updateRecord(cfg.table, rec, await writeRec(cfg.kind, o, cfg.fix || cfg.proj), base);
  return { ok: true };
}
async function sectionDelete(id, rec) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  if (cfg.kind === 'events') {
    // 重大事项删除：同步清理其对应的「项目」记录与全部任务，避免留下孤儿数据
    // （任务仅能经由此重大事项的展开入口访问，删事项即应一并清理）。
    try {
      const m = await sectionRecord(id, rec);
      const name = m && m.title ? (m.title || '').trim() : '';
      const projRec = name ? PROJ_MAP[name] : null;
      if (projRec) {
        const tasks = (await loadProjTasks()).filter(r => linkId(r['项目']) === projRec);
        for (const r of tasks) await deleteRecord('项目任务', r.record_id, base);
        await deleteRecord('项目', projRec, base);
        delete PROJ_MAP[name];
        delete SECTIONS['major_' + rec];
      }
    } catch (e) { console.warn('重大事项级联清理失败（主删除仍继续）:', e.message); }
    await deleteRecord(cfg.table, rec, base);
    return { ok: true };
  }
  if (cfg.kind === 'ptask') {
    await ensureProjects();
    // 级联删除：删除该任务及其全部后代（子/孙/…），避免表中残留
    // 「上级任务标题」指向已删除 ID 的孤儿记录（既不能多删也不能少删）。
    const raw = (await listTable(cfg.table, base)).filter(r => passFilter(cfg.kind, r, cfg.fix || cfg.proj));
    const tasks = raw.map(r => readRec(cfg.kind, r));
    const toDelete = new Set();
    const target = tasks.find(t => t.id === rec);
    if (!target) {
      toDelete.add(rec); // 找不到对应任务时也直接删原记录
    } else {
      // 构建 parent(tid 字符串) -> 子任务 映射
      const childrenMap = new Map();
      tasks.forEach(t => {
        const p = (t.parent || '').trim();
        if (!p) return;
        if (!childrenMap.has(p)) childrenMap.set(p, []);
        childrenMap.get(p).push(t);
      });
      const stack = [String(target.tid)];
      const seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const node = tasks.find(t => String(t.tid) === cur);
        if (node) toDelete.add(node.id);
        const kids = childrenMap.get(cur);
        if (kids) kids.forEach(k => stack.push(String(k.tid)));
      }
    }
    for (const rid of toDelete) await deleteRecord(cfg.table, rid, base);
    return { ok: true, deleted: toDelete.size };
  }
  await deleteRecord(cfg.table, rec, base);
  return { ok: true };
}

/* ===================== 文章录入（写入「录入表」等待 skill 分析） ===================== */
async function createPendingArticle({ title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag, ctype, summary }) {
  const fields = {
    '文案标题': title || '',
    '原始文案': content || '',
    '来源': source || '',
    '录入日期': Date.now(),
    '个人感悟': reflection || '',
    '是否多篇': multi ? '1' : '0'
  };
  if (sourceLink && sourceLink.trim()) fields['来源链接'] = sourceLink.trim();
  // 一级/二级/三级分类 + 标签：单选字段，INSPIRE_BASE 走 v1，单选值直接传字符串；非空才写入（非必填）
  if (cat1 && cat1.trim()) fields['一级分类'] = cat1.trim();
  if (cat2 && cat2.trim()) fields['二级分类'] = cat2.trim();
  if (cat3 && cat3.trim()) fields['三级分类'] = cat3.trim();
  if (tag && tag.trim()) fields['标签'] = tag.trim();
  // 内容类型（单选）/ AI总结（核心关键点，文本）：仅当录入表已建立对应字段时生效；
  // 飞书会忽略表中不存在的字段名（不报错），故即便录入表尚未加这两个字段也不会写失败。
  if (ctype && ctype.trim()) fields['内容类型'] = ctype.trim();
  if (summary && summary.trim()) fields['AI总结'] = summary.trim();
  const id = await createRecord(INPUT_TABLE, fields, INSPIRE_BASE);
  return id;
}

/* ===================== 文章直接录入（不经录入表，直接写「人生灵感库」） ===================== */
async function createDirectArticle({ title, content, source, sourceLink, reflection, cat1, cat2, cat3, tag, ctype, summary }) {
  const fields = {
    '文案标题': title || '',
    '原始文案': content || '',
    '来源': source || '',
    '个人感悟': reflection || '',
    '收藏日期': toFeishuDate(new Date().toISOString().slice(0, 10)),
    '是否整理': '未整理'
  };
  if (sourceLink && sourceLink.trim()) fields['来源链接'] = sourceLink.trim();
  // 单选字段（一级/二级/三级分类、标签、内容类型）：空值不写入，否则飞书 SingleSelectFieldConvFail「must be a string」
  if (cat1 && cat1.trim()) fields['一级分类'] = cat1.trim();
  if (cat2 && cat2.trim()) fields['二级分类'] = cat2.trim();
  if (cat3 && cat3.trim()) fields['三级分类'] = cat3.trim();
  if (tag && tag.trim()) fields['标签'] = tag.trim();
  if (ctype && ctype.trim()) fields['内容类型'] = ctype.trim();
  if (summary && summary.trim()) fields['AI总结'] = summary.trim();
  const id = await createRecord(INSPIRE_TABLE, fields, INSPIRE_BASE);
  return id;
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

/* ===================== 项目 ===================== */
// 项目任务全表短缓存：避免每次渲染（以及 nextTaskId）都全表重拉两次，缓解打开卡顿
let _ptaskCache = { ts: 0, data: null };
async function loadProjTasks() {
  if (_ptaskCache.data && Date.now() - _ptaskCache.ts < 5000) return _ptaskCache.data;
  _ptaskCache.data = await listTable('项目任务');
  _ptaskCache.ts = Date.now();
  return _ptaskCache.data;
}
async function getProject(section) {
  await ensureProjects();
  const cfg = SECTIONS[section];
  const projRec = PROJ_MAP[cfg.proj];
  const tasks = (await loadProjTasks()).filter(r => linkId(r['项目']) === projRec)
    .map(r => readRec('ptask', r))
    .sort((a, b) => (a.tid || 0) - (b.tid || 0));
  return { tasks, desc: PROJ_DESC[projRec] || '' };
}
// 项目任务自增 ID：取该项目下现有最大 ID + 1（飞书无原生自增字段，由代码维护）
async function nextTaskId(projRec) {
  const rows = (await loadProjTasks()).filter(r => linkId(r['项目']) === projRec);
  let max = 0;
  rows.forEach(r => { const v = num(r['ID']); if (v > max) max = v; });
  return max + 1;
}
async function saveProjectDesc(section, desc) {
  await ensureProjects();
  const cfg = SECTIONS[section];
  const projRec = PROJ_MAP[cfg.proj];
  await updateRecord('项目', projRec, { '说明': desc });
  PROJ_DESC[projRec] = desc;
  return { ok: true };
}

// 重大事项 → 项目任务「根」映射：确保同名「项目」记录存在，并动态注册一个 ptask 类型的
// SECTIONS 条目（id = 'major_' + 重大事项记录 id），使该重大事项可像「淘宝发圈」一样展开思维导图。
// 所有子任务都挂在「项目任务」表里，通过「项目」关联字段指向这个同名「项目」记录。
async function ensureMajorSection(majorRecId) {
  await ensureProjects();
  const m = await sectionRecord('major', majorRecId);
  if (!m || !m.title) return { ok: true, proj: null };
  const name = (m.title || '').trim();
  let projRec = PROJ_MAP[name];
  if (!projRec) {
    projRec = await createRecord('项目', { '项目': name });
    PROJ_MAP[name] = projRec;
  }
  const secId = 'major_' + majorRecId;
  if (!SECTIONS[secId]) SECTIONS[secId] = { table: '项目任务', kind: 'ptask', proj: name, accent: '#8b5cf6' };
  return { ok: true, proj: name, secId };
}

/* ===================== Dashboard 聚合 ===================== */
async function getDashboard() {
  const todos = (await listTable('每日待办')).map(r => readRec('todos', r));
  const t = today();
  const todayTodos = todos.filter(x => x.date === t);
  const habits = await getHabits();
  const major = (await listTable('重大事项')).map(r => readRec('events', r));
  const projCount = (await loadProjTasks()).length;
  const insp = (await listTable(INSPIRE_TABLE, INSPIRE_BASE)).length;
  const topics = (await listTable('选题库')).length;
  const knowledge = (await listTable(INSPIRE_TABLE, INSPIRE_BASE)).length;
  // 录入表（文章录入）里尚未被 skill 分析写入「人生灵感库」的待处理条数
  const inputPending = (await listTable(INPUT_TABLE, INSPIRE_BASE)).length;
  return { todayTodos, todoPending: todayTodos.filter(x => !x.done).length, habits, major, projCount, insp, topics, knowledge, inputPending };
}

/* ===================== 计划表格（年计划/月计划 类 Excel 网格） ===================== */
async function tableExists(name, baseToken = BASE_TOKEN) {
  const pre = await basePrefix(baseToken);
  const j = await feishuRequest('GET', `${pre}/tables?page_size=200`);
  const items = (j.data && j.data.items) || [];
  const t = items.find(x => x.name === name);
  return t ? t.table_id : null;
}
async function createTableOpen(name, fields) {
  const pre = await basePrefix(BASE_TOKEN);
  // 飞书 OpenAPI 建表：请求体必须包成 { table: { name } }（不能带 default_view_name，会 1254001；
  // 也不能带 fields，同样 1254001）。建完空表再逐个补字段。table_id 在 data.table_id。
  const j = await feishuRequest('POST', `${pre}/tables`, { table: { name } });
  const tid = j.data.table_id;
  for (const f of fields) {
    try { await feishuRequest('POST', `${pre}/tables/${encodeURIComponent(tid)}/fields`, { field_name: f.name, type: f.type }); }
    catch (e) { /* 字段可能已存在，忽略 */ }
  }
  return tid;
}
/* ===================== 年/月度计划 2.0 表名常量已上移至 SECTIONS 之前（避免 TDZ 启动崩溃） ===================== */
// 说明：年/月计划现已统一走通用 /api/section/:id 本地优先层（readRec/writeRec/sectionCreate 等），
// 其字段映射见上方 readRec/writeRec 的 'annual2' / 'monthplan2' 分支；专用 helper 已移除。
// 向某表的单选字段追加一个新选项。
// ⚠️ 飞书不支持 POST .../fields/{id}/options 追加（返回 404），必须 PUT 全量 options：
//    已有项带原 id，新项只给 name，由飞书分配 id。
async function addSingleSelectOption(baseToken, tableName, fieldName, newName) {
  newName = (newName || '').toString().trim();
  if (!newName) throw new Error('选项名称不能为空');
  const pre = await basePrefix(baseToken);
  const tid = await tableId(tableName, baseToken);
  const fj = await feishuRequest('GET', `${pre}/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
  const items = (fj.data && (fj.data.items || fj.data.fields)) || [];
  const field = items.find(f => (f.field_name || f.name) === fieldName);
  if (!field) throw new Error('未找到字段：' + fieldName);
  const opts = (field.property && field.property.options) || [];
  if (opts.some(o => (o.name || '') === newName)) return opts.map(o => o.name); // 已存在，直接返回
  const fullOpts = opts.map(o => ({ id: o.id, name: o.name }));
  fullOpts.push({ name: newName });
  await feishuRequest('PUT', `${pre}/tables/${encodeURIComponent(tid)}/fields/${field.field_id}`, {
    field_name: field.field_name || field.name,
    type: field.type || 3,                       // 单选字段 type=3
    property: { options: fullOpts }
  });
  return fullOpts.map(o => o.name);
}
// 读取某表单选字段当前所有选项的文本列表
async function getSingleSelectOptions(baseToken, tableName, fieldName) {
  const pre = await basePrefix(baseToken);
  const tid = await tableId(tableName, baseToken);
  const fj = await feishuRequest('GET', `${pre}/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
  const items = (fj.data && (fj.data.items || fj.data.fields)) || [];
  const field = items.find(f => (f.field_name || f.name) === fieldName);
  if (!field) return [];
  const opts = (field.property && field.property.options) || [];
  return opts.map(o => o.name).filter(Boolean);
}
// 自动确保「类型」单选字段存在「分组」选项（用于按年份保存每行分组数）。
// 该选项在首次部署后由本函数按需补齐，无需手工改飞书表结构。
let _a2GroupOptOk = false;
async function ensureAnnual2GroupOption() {
  if (_a2GroupOptOk) return;
  try {
    await addSingleSelectOption(BASE_TOKEN, ANNUAL2_TABLE, '类型', '分组');
    _a2GroupOptOk = true;
    console.log('✅ 已为「年度计划.类型」补齐单选选项：分组');
  } catch (e) {
    console.warn('[annual2] 确保「分组」选项失败（下次请求重试）：', e.message || e);
  }
}

/* ===================== 分类表（级联下拉数据源） ===================== */
let _catCache = null, _catTime = 0;
async function getCategory() {
  const now = Date.now();
  if (_catCache && now - _catTime < 3600 * 1000) return _catCache;   // 1 小时缓存
  let result = null;
  try {
    const rows = await listTable(CATEGORY_TABLE, INSPIRE_BASE);   // 原始 select 字段，需 sel() 取文本
    const cat1 = [], tree = {};
    rows.forEach(r => {
      const a = sel(r['一级分类']) || '', b = sel(r['二级分类']) || '', c = sel(r['三级分类']) || '';
      if (!a) return;
      if (!cat1.includes(a)) cat1.push(a);
      tree[a] = tree[a] || {};
      tree[a][b] = tree[a][b] || [];
      if (c && !tree[a][b].includes(c)) tree[a][b].push(c);
    });
    result = { cat1, tree };
  } catch (e) {
    // 飞书抖动时回退到仓库内置 category.json，保证下拉始终可用
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'category.json'), 'utf8'));
      result = { cat1: raw.cat1 || [], tree: raw.tree || {} };
    } catch (e2) { result = { cat1: [], tree: {} }; }
  }
  _catCache = result; _catTime = now;
  return result;
}

/* ===================== 灵感类型（飞书表维护，可自由新增） ===================== */
let _inspTypeCache = null, _inspTypeTime = 0;
async function ensureInspTypeTable() {
  // 仅 OpenAPI 模式自动建表；返回 true 表示本次刚建好并种入默认类型
  if (!USE_OPENAPI) return false;
  const exists = await tableExists(INSP_TYPE_TABLE, BASE_TOKEN);
  if (exists) return false;
  await createTableOpen(INSP_TYPE_TABLE, [{ name: '类型', type: 1 }]);
  _tableCache[BASE_TOKEN] = null;   // 清缓存，确保 tableId 重新拉取
  for (const d of INSP_TYPE_DEFAULTS) {
    try { await createRecord(INSP_TYPE_TABLE, { '类型': d }, BASE_TOKEN); } catch (e) { /* 忽略 */ }
  }
  _inspTypeCache = INSP_TYPE_DEFAULTS.slice(); _inspTypeTime = Date.now();
  return true;
}
async function getInspTypes() {
  const now = Date.now();
  if (_inspTypeCache && now - _inspTypeTime < 3600 * 1000) return _inspTypeCache;
  let result = [];
  try {
    const justCreated = await ensureInspTypeTable();
    if (justCreated) return _inspTypeCache;          // 刚建好已含默认类型
    const rows = await listTable(INSP_TYPE_TABLE, BASE_TOKEN);
    const set = new Set();
    rows.forEach(r => { const v = (r['类型'] || '').toString().trim(); if (v) set.add(v); });
    result = Array.from(set);
  } catch (e) { result = []; }
  _inspTypeCache = result; _inspTypeTime = now;
  return result;
}
async function addInspType(type) {
  type = (type || '').toString().trim();
  if (!type) return getInspTypes();
  await ensureInspTypeTable();
  await createRecord(INSP_TYPE_TABLE, { '类型': type }, BASE_TOKEN);
  _inspTypeCache = null;   // 失效缓存，下次重新拉取最新列表
  return getInspTypes();
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
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
    if (method === 'GET' && url === '/api/input-pending') {
      // 录入表待处理条数（文章录入后、被 skill 写入人生灵感库前）。count=-1 表示查询失败。
      try {
        const count = (await listTable(INPUT_TABLE, INSPIRE_BASE)).length;
        return send(res, 200, { count });
      } catch (e) { return send(res, 200, { count: -1, error: e.message }); }
    }
    if (method === 'GET' && url === '/api/category') return send(res, 200, await getCategory());
    if (method === 'GET' && url === '/api/insp-types') return send(res, 200, { types: await getInspTypes() });
    if (method === 'POST' && url === '/api/insp-types') {
      const t = (body && body.type || '').toString().trim();
      if (!t) return send(res, 400, { error: '类型名称不能为空' });
      return send(res, 200, { types: await addInspType(t) });
    }
    // 精神角落「分类」单选：读取当前选项 / 追加自定义新分类（即时生效）
    if (method === 'GET' && url === '/api/book-categories') {
      try { return send(res, 200, { options: await getSingleSelectOptions(BASE_TOKEN, '精神角落', '分类') }); }
      catch (e) { console.warn('[book-categories] 读取失败：', e.message || e); return send(res, 200, { options: [] }); }
    }
    if (method === 'POST' && url === '/api/book-categories') {
      const name = (body && body.name || '').toString().trim();
      if (!name) return send(res, 400, { error: '分类名称不能为空' });
      try { return send(res, 200, { ok: true, options: await addSingleSelectOption(BASE_TOKEN, '精神角落', '分类', name) }); }
      catch (e) { return send(res, 500, { error: e.message || '添加分类失败' }); }
    }
    // —— 以下模块（微习惯/日复盘/日记/年度计划/月度计划）现已统一走 /api/section/:id 本地优先层，
    //     不再保留专用路由（create/delete 的逐条逻辑由通用 sectionCreate/sectionUpdate/sectionDelete 处理）。
    if (method === 'GET' && (m = url.match(/^\/api\/project\/([\w]+)$/))) return send(res, 200, await getProject(m[1]));
    if (method === 'PUT' && url === '/api/project-desc') return send(res, 200, await saveProjectDesc(body.section, body.desc));
    // 重大事项展开前置：确保同名「项目」记录存在并注册动态 SECTIONS 条目（使该重大事项可像项目一样展开思维导图）
    if (method === 'POST' && (m = url.match(/^\/api\/major-ensure\/([\w]+)$/))) return send(res, 200, await ensureMajorSection(m[1]));
    if (method === 'POST' && url === '/api/article-input') {
      const { title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag, ctype, summary } = body || {};
      if (!content || !content.trim()) return send(res, 400, { error: '原始文案不能为空' });
      const id = await createPendingArticle({ title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag, ctype, summary });
      return send(res, 200, { ok: true, record_id: id });
    }
    if (method === 'POST' && url === '/api/article-direct') {
      const { title, content, source, sourceLink, reflection, cat1, cat2, cat3, tag, ctype, summary } = body || {};
      if (!content || !content.trim()) return send(res, 400, { error: '原始文案不能为空' });
      const id = await createDirectArticle({ title, content, source, sourceLink, reflection, cat1, cat2, cat3, tag, ctype, summary });
      return send(res, 200, { ok: true, record_id: id });
    }
    if ((m = (req.url.split('?')[0]).match(/^\/api\/section\/([\w]+)(?:\/(.+))?$/))) {
      const id = m[1], rec = m[2];
      if (!SECTIONS[id]) return send(res, 404, { error: '未知模块: ' + id });
      const cfg = SECTIONS[id];
      const base = cfg.base || BASE_TOKEN;
      if (cfg.readonly && method !== 'GET' && method !== 'DELETE' && !(cfg.allowEdit && method === 'PUT')) return send(res, 403, { error: '该板块为只读（数据来自外部多维表格，请在飞书中维护；仅支持删除与编辑）' });
      if (method === 'GET' && rec) return send(res, 200, await sectionRecord(id, rec));
      if (method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const opts = {
          q: u.searchParams.get('q') || '', cat1: u.searchParams.get('cat1') || '', cat2: u.searchParams.get('cat2') || '',
          tag: u.searchParams.get('tag') || '', ctype: u.searchParams.get('ctype') || '', status: u.searchParams.get('status') || '',
          page: u.searchParams.get('page'), pageSize: u.searchParams.get('pageSize'),
          full: u.searchParams.get('full') === '1'
        };
        return send(res, 200, await sectionList(id, opts));
      }
      if (method === 'POST') { const r = await sectionCreate(id, body || {}); invalidateCache(cfg, base); return send(res, 200, r); }
      if (method === 'PUT' && rec) { await sectionUpdate(id, rec, body || {}); invalidateCache(cfg, base); return send(res, 200, { ok: true }); }
      if (method === 'DELETE' && rec) { await sectionDelete(id, rec); invalidateCache(cfg, base); return send(res, 200, { ok: true }); }
      return send(res, 405, { error: '方法不允许' });
    }
    return send(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('API error:', e.message);
    return send(res, e.status || 500, { error: e.message });
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
