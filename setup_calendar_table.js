#!/usr/bin/env node
// 一次性建表脚本（OpenAPI 模式）：创建「日程」表（日历 / 日程提醒），幂等：表已存在则跳过。
// 字段：日期(type5 日期) / 标题(type1 文本) / 时间(type1 文本，如 14:30) / 备注(type1 文本) / 提醒(type7 复选框)。
// 用法： node ./setup_calendar_table.js   （自动读取 .env.local 的 FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN）
const fs = require('fs');
const { execSync } = require('child_process');

// ---- 读取凭据 ----
let APP_ID = process.env.FEISHU_APP_ID, APP_SECRET = process.env.FEISHU_APP_SECRET, BASE = process.env.BASE_TOKEN;
if ((!APP_ID || !APP_SECRET) && fs.existsSync('.env.local')) {
  const txt = fs.readFileSync('.env.local', 'utf8');
  txt.split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
  APP_ID = APP_ID || process.env.FEISHU_APP_ID;
  APP_SECRET = APP_SECRET || process.env.FEISHU_APP_SECRET;
}
BASE = BASE || process.env.BASE_TOKEN || 'Wwtfbm66VaJyLOsBQaTcTm1vnHg';
if (!APP_ID || !APP_SECRET || !BASE) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const PRE = `${API}/bitable/v1/apps/${BASE}`;
const REQ = '_req_tmp.json';

function sh(cmd) { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
function curlJson(method, url, bodyObj) {
  let cmd = `curl -s -X ${method} "${url}" -H "Authorization: Bearer ${tok}"`;
  if (bodyObj) { fs.writeFileSync(REQ, JSON.stringify(bodyObj)); cmd += ` -H "Content-Type: application/json" --data @${REQ}`; }
  try { return JSON.parse(sh(cmd)); }
  finally { if (fs.existsSync(REQ)) try { fs.unlinkSync(REQ); } catch (e) {} }
}

// ---- token ----
fs.writeFileSync(REQ, JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }));
const tj = JSON.parse(sh(`curl -s -X POST -H "Content-Type: application/json" --data @${REQ} "${API}/auth/v3/tenant_access_token/internal"`));
try { fs.unlinkSync(REQ); } catch (e) {}
const tok = tj.tenant_access_token || (tj.data && tj.data.tenant_access_token);
if (!tok) { console.error('❌ 获取 token 失败', JSON.stringify(tj).slice(0, 200)); process.exit(1); }
console.log('✅ token ok (len ' + tok.length + ')');

// ---- 表查询 / 创建 ----
function tidOf(name) {
  const j = curlJson('GET', `${PRE}/tables?page_size=200`);
  const t = (j.data.items || []).find(x => x.name === name);
  return t ? t.table_id : '';
}
function createTable(name, fields) {
  const existing = tidOf(name);
  if (existing) { console.log(`↺ 表「${name}」已存在 (${existing})，跳过建表`); return existing; }
  console.log(`===== 创建表：${name} =====`);
  const bj = curlJson('POST', `${PRE}/tables`, { table: { name } });
  let tid = bj.data && bj.data.table_id;
  if (!tid) { tid = tidOf(name); }
  if (!tid) { console.error('❌ 建表失败', JSON.stringify(bj).slice(0, 200)); process.exit(1); }
  for (const f of fields) {
    curlJson('POST', `${PRE}/tables/${encodeURIComponent(tid)}/fields`, { field_name: f.name, type: f.type });
    console.log(`  + 字段 ${f.name} (type ${f.type})`);
  }
  return tid;
}

createTable('日程', [
  { name: '日期', type: 5 },
  { name: '标题', type: 1 },
  { name: '时间', type: 1 },
  { name: '备注', type: 1 },
  { name: '提醒', type: 7 },
]);
console.log('ALL DONE ✅');
