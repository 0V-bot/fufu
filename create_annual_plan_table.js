#!/usr/bin/env node
// 在「傅傅的工作台」main base 新建「年度计划」表（幂等）。
// 字段（7 个）：
//   1) 年份       type 2 (数字，4 位年份)
//   2) 类型       type 3 (单选：开头 / 结尾 / 标题 / 内容)
//   3) 格子颜色   type 1 (文本，颜色代码 #RRGGBB)
//   4) 文案       type 1 (文本，文字内容)
//   5) 文字颜色   type 1 (文本，文字颜色代码)
//   6) 排序       type 2 (数字，ABBCC 五位)
//   7) 完成标记   type 7 (复选框)
// 用法： node ./create_annual_plan_table.js
// 中文一律以临时文件方式传给 curl（规避 Git Bash 命令行 GBK 编码导致名称不匹配）。
const fs = require('fs');
const { execSync } = require('child_process');

let APP_ID = process.env.FEISHU_APP_ID, APP_SECRET = process.env.FEISHU_APP_SECRET;
if ((!APP_ID || !APP_SECRET) && fs.existsSync('.env.local')) {
  const txt = fs.readFileSync('.env.local', 'utf8');
  txt.split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
  APP_ID = APP_ID || process.env.FEISHU_APP_ID;
  APP_SECRET = APP_SECRET || process.env.FEISHU_APP_SECRET;
}
const BASE = process.env.BASE_TOKEN || 'Wwtfbm66VaJyLOsBQaTcTm1vnHg';
if (!APP_ID || !APP_SECRET) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const REQ = '_ap_req_tmp.json';
const OUT = '_ap_out.json';
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

const TABLE_NAME = '年度计划';
const FIELDS = [
  { name: '年份',     type: 2 },
  { name: '类型',     type: 3, property: { options: [{ name: '开头' }, { name: '结尾' }, { name: '标题' }, { name: '内容' }] } },
  { name: '格子颜色', type: 1 },
  { name: '文案',     type: 1 },
  { name: '文字颜色', type: 1 },
  { name: '排序',     type: 2 },
  { name: '完成标记', type: 7 },
];

// ---- 检查表是否存在 ----
const tj2 = curlJson('GET', '/tables?page_size=200');
const tables = (tj2.data && tj2.data.items) || [];
let tid = null;
const existing = tables.find(t => t.name === TABLE_NAME);
if (existing) { tid = existing.table_id; console.log(`ℹ️ 表「${TABLE_NAME}」已存在 (${tid})`); }
else {
  const cj = curlJson('POST', '/tables', { table: { name: TABLE_NAME } });
  if (cj.code !== 0) { console.error('❌ 建表失败:', JSON.stringify(cj).slice(0, 400)); process.exit(1); }
  tid = cj.data.table_id;
  console.log(`✅ 已创建表「${TABLE_NAME}」(${tid})`);
}

// ---- 幂等补字段 ----
const fj = curlJson('GET', `/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
const have = ((fj.data && fj.data.items) || []).map(f => f.field_name);
console.log(`\n现有字段：${have.join(', ') || '(无)'}`);
for (const f of FIELDS) {
  if (have.includes(f.name)) { console.log(`  ↺ ${f.name} 已存在，跳过`); continue; }
  const body = { field_name: f.name, type: f.type };
  if (f.property) body.property = f.property;
  const r = curlJson('POST', `/tables/${encodeURIComponent(tid)}/fields`, body);
  console.log(`  ${r.code === 0 ? '✅' : '⚠️'} 新增字段 ${f.name} (type ${f.type}) ${r.code === 0 ? '' : JSON.stringify(r).slice(0, 200)}`);
}

console.log('\nALL DONE ✅');
