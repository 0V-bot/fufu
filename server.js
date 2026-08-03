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
const toFeishuDate = s => {
  if (!s) return s;
  if (typeof s === 'number') return s;
  const ms = Date.parse(s.includes(' ') ? s : s + ' 00:00:00');
  return isNaN(ms) ? s : ms;
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
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
// 统一按北京时间(东八区)计算"今天"，避免服务器 UTC 时区导致待办/复盘日期差一天
const today = () => { const d = new Date(Date.now() + 8 * 3600 * 1000), p = n => (n < 10 ? '0' + n : '' + n); return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()); };
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
  annual:      { table: GRID_TABLE, kind: 'annual',  fix: '年计划' },
  monthly:     { table: GRID_TABLE, kind: 'grid',     fix: '月计划' },
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
    emotion: multi(r['情绪标签']),
    keywords: r['关键词'] || '',
    summary: r['AI总结'] || '',
    quote: r['金句提炼'] || '',
    scenes: multi(r['适用场景']),
    rewrite: r['改写方向'] || '',
    original: r['原始文案'] || '',
    date: dateOnly(r['收藏日期']),
    abstract: r['AI搜索摘要'] || '',
    ctype: sel(r['内容类型']) || '',
    status: sel(r['使用状态']) || '',
    source: r['来源'] || '',
    sourceLink: slText,
    reflection: r['个人感悟'] || '',
    copyright: r['版权备注'] || ''
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
    case 'topics':    return { id: r.record_id, title: r['选题'], platform: r['平台'] || '', status: sel(r['状态']) || '', note: r['备注'] || '' };
    case 'publish':   return { id: r.record_id, date: dateOnly(r['日期']), platform: r['平台'] || '', title: r['标题'], link: r['链接'] || '', result: r['数据反馈'] || '' };
    // 知识库分类页与人生灵感库同源同结构，返回完整字段，供富详情弹窗展示/编辑
    case 'knowledge': return readInspireFields(r);
    case 'ptask':     return { id: r.record_id, title: r['任务'], status: sel(r['状态']) || '', note: r['备注'] || '' };
    case 'books':     return { id: r.record_id, title: r['书名'] || '', author: r['作者'] || '', category: sel(r['分类']) || '', status: sel(r['状态']) || '', rating: num(r['评分']), note: r['读后感'] || '', source: r['来源'] || '', date: dateOnly(r['日期']) };
  }
  return { id: r.record_id };
}
function writeRec(kind, o, fix) {
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
    case 'topics':    return { '选题': o.title, '平台': o.platform || '', '状态': o.status || '灵感', '备注': o.note || '' };
    case 'publish':   return { '标题': o.title, '日期': toFeishuDate(o.date), '平台': o.platform || '', '链接': o.link || '', '数据反馈': o.result || '' };
    case 'knowledge': return { '文案标题': o.title, '标签': o.tags || '', '来源': o.source || '', 'AI总结': o.content || '' };
    case 'ptask':     return { '任务': o.title, '项目': [PROJ_MAP[fix]], '状态': o.status || '待办', '备注': o.note || '' };
    case 'books': {
      // 注意：单选字段（分类/状态）传空字符串会被飞书拒绝(not_found)，故空值不写入
      const f = { '书名': o.title, '作者': o.author || '', '状态': o.status || '想读', '评分': num(o.rating), '读后感': o.note || '', '来源': o.source || '', '日期': toFeishuDate(o.date) };
      if (o.category && String(o.category).trim()) f['分类'] = String(o.category).trim();
      return f;
    }
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
const INSPIRE_LIST_FIELDS = ['ID', '文案标题', '一级分类', '二级分类', '三级分类', '分类', '标签', '情绪标签', '内容类型', '金句提炼', 'AI总结', '关键词', '使用状态', '来源', '收藏日期'];
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
  const keep = ['id', 'ID', 'title', 'cat1', 'cat2', 'cat3', 'tag', 'emotion', 'quote', 'summary', 'keywords', 'ctype', 'date', 'status', 'source'];
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
async function sectionCreate(id, o) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  if (cfg.kind === 'ptask') await ensureProjects();
  return { id: await createRecord(cfg.table, writeRec(cfg.kind, o, cfg.fix || cfg.proj), base) };
}
async function sectionUpdate(id, rec, o) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  if (cfg.kind === 'ptask') await ensureProjects();
  await updateRecord(cfg.table, rec, writeRec(cfg.kind, o, cfg.fix || cfg.proj), base);
  return { ok: true };
}
async function sectionDelete(id, rec) {
  const cfg = SECTIONS[id];
  const base = cfg.base || BASE_TOKEN;
  await deleteRecord(cfg.table, rec, base);
  return { ok: true };
}

/* ===================== 文章录入（写入「录入表」等待 skill 分析） ===================== */
async function createPendingArticle({ title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag }) {
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
  const id = await createRecord(INPUT_TABLE, fields, INSPIRE_BASE);
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
  else await createRecord('习惯打卡', { '习惯': [hid], '打卡日期': toFeishuDate(date), '打卡': true });
  return { ok: true };
}

/* ===================== 日复盘 ===================== */
async function getReview() {
  return (await listTable('日复盘')).map(r => ({ date: dateOnly(r['日期']), title: r['主题'] || '', text: r['内容'] || '' }));
}
async function saveReview(date, text) {
  const found = (await listTable('日复盘')).find(r => dateOnly(r['日期']) === date);
  if (found) await updateRecord('日复盘', found.record_id, { '内容': text });
  else await createRecord('日复盘', { '主题': date, '日期': toFeishuDate(date), '内容': text });
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
let _gridReady = false, _gridTid = null;
async function ensureGridTable() {
  if (_gridReady) return _gridTid;
  const tid = await tableExists(GRID_TABLE, BASE_TOKEN);
  if (tid) { _gridTid = tid; _gridReady = true; return tid; }
  // 表不存在则自动创建（仅 OpenAPI 模式；lark-cli 本地回退需手动建表）
  if (USE_OPENAPI) {
    _gridTid = await createTableOpen(GRID_TABLE, [{ name: '名称', type: 1 }, { name: '网格', type: 1 }]);
    _gridReady = true;
    // 清缓存，让 tableId 在下次需要时重新拉取整表列表（含新建的表），避免把表名当 id
    _tableCache[BASE_TOKEN] = null;
    return _gridTid;
  }
  _gridReady = true; _gridTid = GRID_TABLE;
  return _gridTid;
}
function normGridObj(g) {
  g = g || {}; g.rows = Number(g.rows) || 6; g.cols = Number(g.cols) || 4;
  g.data = Array.isArray(g.data) ? g.data : [];
  for (let r = 0; r < g.rows; r++) {
    if (!g.data[r]) g.data[r] = [];
    for (let c = 0; c < g.cols; c++) {
      const cell = g.data[r][c] || {};
      g.data[r][c] = { t: cell.t == null ? '' : String(cell.t), rs: Number(cell.rs) || 1, cs: Number(cell.cs) || 1 };
    }
    g.data[r].length = g.cols;
  }
  g.data.length = g.rows;
  return g;
}
function defaultGrid() { return normGridObj({ rows: 6, cols: 4, data: [] }); }
async function loadGrid(name) {
  await ensureGridTable();
  let rows = [];
  try { rows = await listTable(GRID_TABLE, BASE_TOKEN); } catch (e) { rows = []; }
  const rec = rows.find(x => (x['名称'] || '') === name);
  if (rec && rec['网格']) {
    try { return normGridObj(JSON.parse(rec['网格'])); } catch (e) {}
  }
  // 首次使用：尝试从旧「目标管理」(类型=name) 迁移成表格，避免已有数据丢失
  try {
    const goals = (await listTable('目标管理', BASE_TOKEN)).filter(r => sel(r['类型']) === name).map(r => readRec('goals', r));
    if (goals.length) {
      const g = defaultGrid(); g.rows = goals.length + 1; g.cols = 4; g.data = [];
      const mk = t => ({ t: String(t == null ? '' : t), rs: 1, cs: 1 });
      g.data.push([mk('目标'), mk('说明'), mk('进度'), mk('状态')]);
      goals.forEach(go => g.data.push([mk(go.title), mk(go.detail), mk((Number(go.progress) || 0) + '%'), mk(go.status)]));
      g.data.length = g.rows; g.data.forEach(row => row.length = g.cols);
      return g;
    }
  } catch (e) {}
  return defaultGrid();
}
async function saveGrid(name, grid) {
  await ensureGridTable();
  const g = normGridObj(grid);
  let rows = [];
  try { rows = await listTable(GRID_TABLE, BASE_TOKEN); } catch (e) { rows = []; }
  const rec = rows.find(x => (x['名称'] || '') === name);
  const payload = { '名称': name, '网格': JSON.stringify(g) };
  if (rec) await feishuRetry(() => updateRecord(GRID_TABLE, rec.record_id, payload, BASE_TOKEN));
  else await feishuRetry(() => createRecord(GRID_TABLE, payload, BASE_TOKEN));
  return { ok: true };
}

/* ===================== 年计划（按年份存储：每页四列可调整高度） ===================== */
const ANNUAL_COLS = 4;
const annualName = y => '年计划-' + y;
function normAnnual(d) {
  d = d || {};
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const clean = rows.map(r => {
    const c = Array.isArray(r && r.c) ? r.c : [];
    const cols = [];
    for (let i = 0; i < ANNUAL_COLS; i++) cols.push(c[i] == null ? '' : String(c[i]));
    cols.length = ANNUAL_COLS;
    let h = Number(r && r.h) || 140;
    if (h < 60) h = 60; if (h > 800) h = 800;
    return { c: cols, h };
  });
  return { summary: d.summary == null ? '' : String(d.summary), cols: ANNUAL_COLS, rows: clean };
}
async function getAnnual(year) {
  await ensureGridTable();
  let rows = [];
  try { rows = await listTable(GRID_TABLE, BASE_TOKEN); } catch (e) { rows = []; }
  const rec = rows.find(x => (x['名称'] || '') === annualName(year));
  if (rec && rec['网格']) {
    try { return normAnnual(JSON.parse(rec['网格'])); } catch (e) {}
  }
  return normAnnual({ summary: '', rows: [] });
}
async function saveAnnual(year, data) {
  await ensureGridTable();
  const d = normAnnual(data);
  let rows = [];
  try { rows = await listTable(GRID_TABLE, BASE_TOKEN); } catch (e) { rows = []; }
  const rec = rows.find(x => (x['名称'] || '') === annualName(year));
  const payload = { '名称': annualName(year), '网格': JSON.stringify(d) };
  if (rec) await feishuRetry(() => updateRecord(GRID_TABLE, rec.record_id, payload, BASE_TOKEN));
  else await feishuRetry(() => createRecord(GRID_TABLE, payload, BASE_TOKEN));
  return { ok: true };
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
    if (method === 'GET' && url === '/api/habits') return send(res, 200, await getHabits());
    if (method === 'POST' && url === '/api/habits') return send(res, 200, await createHabit(body.name));
    if (method === 'DELETE' && (m = url.match(/^\/api\/habits\/(.+)$/))) return send(res, 200, await deleteHabit(m[1]));
    if (method === 'POST' && url === '/api/habit-toggle') return send(res, 200, await toggleHabit(body.habitId, body.date));
    if (method === 'GET' && url === '/api/review') return send(res, 200, await getReview());
    if (method === 'PUT' && url === '/api/review') return send(res, 200, await saveReview(body.date, body.text));
    if (method === 'DELETE' && (m = url.match(/^\/api\/review\/([\w-]+)$/))) return send(res, 200, await deleteReview(m[1]));
    if (method === 'GET' && (m = url.match(/^\/api\/project\/([\w]+)$/))) return send(res, 200, await getProject(m[1]));
    if (method === 'PUT' && url === '/api/project-desc') return send(res, 200, await saveProjectDesc(body.section, body.desc));
    if (method === 'POST' && url === '/api/article-input') {
      const { title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag } = body || {};
      if (!content || !content.trim()) return send(res, 400, { error: '原始文案不能为空' });
      const id = await createPendingArticle({ title, content, source, sourceLink, reflection, multi, cat1, cat2, cat3, tag });
      return send(res, 200, { ok: true, record_id: id });
    }
    if ((m = url.match(/^\/api\/grid\/([\w]+)$/))) {
      const id = m[1], cfg = SECTIONS[id];
      if (!cfg || cfg.kind !== 'grid') return send(res, 404, { error: '非表格模块: ' + id });
      if (method === 'GET') return send(res, 200, await loadGrid(cfg.fix));
      if (method === 'PUT') { await saveGrid(cfg.fix, (body && body.grid) || {}); return send(res, 200, { ok: true }); }
      return send(res, 405, { error: '方法不允许' });
    }
    if ((m = (req.url.split('?')[0]).match(/^\/api\/annual$/))) {
      const u = new URL(req.url, 'http://localhost');
      const year = Number(u.searchParams.get('year')) || new Date().getFullYear();
      if (method === 'GET') return send(res, 200, await getAnnual(year));
      if (method === 'PUT') { await saveAnnual(year, (body && body.data) || {}); return send(res, 200, { ok: true }); }
      return send(res, 405, { error: '方法不允许' });
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
          tag: u.searchParams.get('tag') || '', ctype: u.searchParams.get('ctype') || '',
          page: u.searchParams.get('page'), pageSize: u.searchParams.get('pageSize')
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
