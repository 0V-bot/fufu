#!/usr/bin/env node
// 新建「日记」表到 main base（OpenAPI 模式，幂等）：
//   若「日记」表已存在则跳过；否则建表并补字段：
//     日期(DATETIME, yyyy-MM-dd) / 天气(TEXT) / 心情(TEXT) / 内容(TEXT)
// 用法： node ./create_diary_table.js
//   中文一律以临时文件方式传给 curl（规避 Git Bash 命令行 GBK 编码导致名称不匹配）。
const fs = require('fs');
const { execSync } = require('child_process');

let APP_ID = process.env.FEISHU_APP_ID, APP_SECRET = process.env.FEISHU_APP_SECRET;
if ((!APP_ID || !APP_SECRET) && fs.existsSync('.env.local')) {
  const txt = fs.readFileSync('.env.local', 'utf8');
  txt.split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
  APP_ID = APP_ID || process.env.FEISHU_APP_ID;
  APP_SECRET = APP_SECRET || process.env.FEISHU_APP_SECRET;
}
const BASE = process.env.BASE_TOKEN || 'Wwtfbm66VaJyLOsBQaTcTm1vnHg'; // main base
if (!APP_ID || !APP_SECRET) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const REQ = '_dt_req.json';
const OUT = '_dt_out.json';
function sh(cmd) { return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
function curlJson(method, path, bodyObj) {
  let cmd = `curl -s -X ${method} "${API}/bitable/v1/apps/${BASE}${path}" -H "Authorization: Bearer ${tok}" -o ${OUT}`;
  if (bodyObj) { fs.writeFileSync(REQ, JSON.stringify(bodyObj)); cmd += ` -H "Content-Type: application/json" --data @${REQ}`; }
  try {
    sh(cmd);
    const txt = fs.readFileSync(OUT, 'utf8');
    try { return JSON.parse(txt); }
    catch (e) { console.error('  ⚠️ 响应解析失败:', txt.slice(0, 300)); return { code: -1, raw: txt.slice(0, 300) }; }
  }
  finally { [REQ, OUT].forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {} }); }
}

// ---- token ----
fs.writeFileSync(REQ, JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }));
const tj = JSON.parse(sh(`curl -s -X POST -H "Content-Type: application/json" --data @${REQ} "${API}/auth/v3/tenant_access_token/internal"`));
try { fs.unlinkSync(REQ); } catch (e) {}
const tok = tj.tenant_access_token || (tj.data && tj.data.tenant_access_token);
if (!tok) { console.error('❌ 获取 token 失败', JSON.stringify(tj).slice(0, 200)); process.exit(1); }
console.log('✅ token ok');

// ---- 是否已存在 ----
const list = curlJson('GET', '/tables?page_size=200');
const tables = (list.data && list.data.items) || [];
const exist = tables.find(t => t.name === '日记');
if (exist) {
  console.log('ℹ️ 「日记」表已存在 (table_id=' + exist.table_id + ')，跳过创建');
  process.exit(0);
}

// ---- 建表（仅名） ----
const created = curlJson('POST', '/tables', { table: { name: '日记' } });
if (created.code !== 0 || !created.data || !created.data.table_id) {
  console.error('❌ 建表失败', JSON.stringify(created).slice(0, 300));
  process.exit(1);
}
const tid = created.data.table_id;
console.log('✅ 已建表「日记」 table_id=' + tid);

// ---- 补字段 ----
const fields = [
  { field_name: '日期', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
  { field_name: '天气', type: 1 },
  { field_name: '心情', type: 1 },
  { field_name: '内容', type: 1 },
];
for (const f of fields) {
  const r = curlJson('POST', `/tables/${encodeURIComponent(tid)}/fields`, f);
  if (r.code === 0) console.log('  + 字段「' + f.field_name + '」已添加');
  else console.error('  ⚠️ 字段「' + f.field_name + '」添加失败:', JSON.stringify(r).slice(0, 200));
}

console.log('🎉 完成');
