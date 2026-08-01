#!/usr/bin/env node
// 一次性建表脚本（OpenAPI 模式）：创建 愿望清单 / 灵感记录 / 灵感类型 三张表，
// 并为「灵感类型」种入 9 个默认类型。幂等：表/类型已存在则跳过。
// 用法： BASE_TOKEN=xxxx node ./setup_new_tables.js
// 注意：中文以文件方式传给 curl（避免 Git Bash 命令行 GBK 编码导致名称不匹配）。
const fs = require('fs');
const path = require('path');
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
BASE = BASE || process.env.BASE_TOKEN;
if (!APP_ID || !APP_SECRET || !BASE) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const PRE = `${API}/bitable/v1/apps/${BASE}`;
const REQ = '_req_tmp.json';

function sh(cmd) { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
function curlJson(method, url, bodyObj) {
  let file = null;
  let cmd = `curl -s -X ${method} "${url}" -H "Authorization: Bearer ${tok}"`;
  if (bodyObj) { fs.writeFileSync(REQ, JSON.stringify(bodyObj)); cmd += ` -H "Content-Type: application/json" --data @${REQ}`; }
  try { return JSON.parse(sh(cmd)); }
  finally { if (file || fs.existsSync(REQ)) try { fs.unlinkSync(REQ); } catch (e) {} }
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
  if (!tid) { tid = tidOf(name); }   // 并发/已存在兜底
  if (!tid) { console.error('❌ 建表失败', JSON.stringify(bj).slice(0, 200)); process.exit(1); }
  for (const f of fields) {
    curlJson('POST', `${PRE}/tables/${encodeURIComponent(tid)}/fields`, { field_name: f.name, type: f.type });
    console.log(`  + 字段 ${f.name} (type ${f.type})`);
  }
  return tid;
}

createTable('愿望清单', [{ name: '内容', type: 1 }, { name: '完成', type: 7 }, { name: '实现时间', type: 5 }]);
createTable('灵感记录', [{ name: '内容', type: 1 }, { name: '类型', type: 1 }, { name: '日期', type: 5 }]);
const TYPE_TID = createTable('灵感类型', [{ name: '类型', type: 1 }]);

// ---- 种入默认灵感类型 ----
console.log('===== 种入默认灵感类型 =====');
const defs = ['健康', '友情', '感情', '心理学', '女性成长', '时间管理', '精力管理', '职场', '情绪管理'];
const have = (curlJson('GET', `${PRE}/tables/${encodeURIComponent(TYPE_TID)}/records?page_size=200`).data.items || []).map(r => r.fields['类型'] || '').filter(Boolean);
for (const tp of defs) {
  if (have.includes(tp)) { console.log(`  ↺ ${tp} 已存在`); continue; }
  curlJson('POST', `${PRE}/tables/${encodeURIComponent(TYPE_TID)}/records`, { fields: { '类型': tp } });
  console.log(`  + ${tp}`);
}
console.log('ALL DONE ✅');
