#!/usr/bin/env node
// 一次性表结构变更脚本（OpenAPI 模式，幂等）：
//   给「录入表」(tblxVYnQ8P49qc6Y，位于 人生研究学院 Base) 新增 2 个字段，
//   使「每日日记」表单的「内容类型」与「核心关键点(AI总结)」能随「先记录，待AI分析」落入录入表，
//   供 life-wisdom-content-processor skill 在分析时直接沿用（写入人生灵感库），不必重新 AI 判断。
//     内容类型 ← 单选（金句/观点/故事/案例/长文），与人生灵感库「内容类型」选项完全一致
//     AI总结   ← 文本
// 用法： node ./setup_input_extra_fields.js
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
const INSPIRE_BASE = process.env.INSPIRE_BASE_TOKEN || 'ARCcbggiUaFqESsV7pRcin8CnUb';
const INPUT_TABLE = process.env.INPUT_TABLE || 'tblxVYnQ8P49qc6Y';
if (!APP_ID || !APP_SECRET) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const REQ = '_req_tmp.json';
function sh(cmd) { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
function curlJson(method, baseToken, path, bodyObj) {
  let cmd = `curl -s -X ${method} "${API}/bitable/v1/apps/${baseToken}${path}" -H "Authorization: Bearer ${tok}"`;
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
console.log('✅ token ok');

function fieldList(baseToken, tid) {
  const j = curlJson('GET', baseToken, `/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
  return (j.data && j.data.items) || [];
}
// type: 1=文本, 3=单选(single select)
function createField(baseToken, tid, name, type, options) {
  const body = { field_name: name, type };
  if (type === 3 && options && options.length) body.property = { options: options.map(n => ({ name: n })) };
  return curlJson('POST', baseToken, `/tables/${encodeURIComponent(tid)}/fields`, body);
}

// ===== 录入表：新增「内容类型」(单选) 与「AI总结」(文本) =====
console.log('===== 录入表：新增「内容类型」「AI总结」字段 =====');
const fields = fieldList(INSPIRE_BASE, INPUT_TABLE);
const CTYPE_OPTS = ['金句', '观点', '故事', '案例', '长文'];
const want = [
  { name: '内容类型', type: 3, opts: CTYPE_OPTS },
  { name: 'AI总结', type: 1, opts: [] },
];
const newIds = {};
want.forEach(w => {
  const ex = fields.find(f => f.field_name === w.name);
  if (ex) { console.log(`  ↺ ${w.name} 已存在 (${ex.field_id})，跳过`); newIds[w.name] = ex.field_id; return; }
  const r = createField(INSPIRE_BASE, INPUT_TABLE, w.name, w.type, w.opts);
  if (r.code !== 0) { console.error(`  ⚠️ 新增 ${w.name} 失败`, JSON.stringify(r).slice(0, 300)); return; }
  const id = (r.data && r.data.field_id) || (r.data && r.data.field && r.data.field.field_id) || '';
  newIds[w.name] = id;
  console.log(`  ✅ 新增 ${w.name} (${id})` + (w.type === 3 ? `，选项 ${w.opts.length} 个` : ''));
});

console.log('\n===== 字段 ID 汇总（供 skill 映射参考）=====');
console.log(JSON.stringify({ 录入表: newIds }, null, 2));
console.log('ALL DONE ✅');
