#!/usr/bin/env node
// 一次性表结构变更脚本（OpenAPI 模式，幂等）：
//   1) 知识库表「分类」单选：把选项「财富」改名为「职场」（保留 option id，历史记录自动级联改名），
//      并新增「情绪管理」选项。
//   2) 人生灵感库表：新增「标签」单选字段，选项 职场 / 女性成长 / 人性 / 健康 / 心理学 / 情绪管理。
// 用法： node ./setup_kb_schema.js
//   （自动读取 .env.local 的 FEISHU_APP_ID/SECRET；BASE_TOKEN / INSPIRE_BASE_TOKEN / INSPIRE_TABLE 可用环境变量覆盖）
// 注意：中文一律以临时文件方式传给 curl（规避 Git Bash 命令行 GBK 编码导致名称不匹配）。
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
const INSPIRE_BASE = process.env.INSPIRE_BASE_TOKEN || 'ARCcbggiUaFqESsV7pRcin8CnUb';
const INSPIRE_TABLE = process.env.INSPIRE_TABLE || 'tblpI6WqsvA5z0CL';
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

function tidOf(baseToken, name) {
  const j = curlJson('GET', baseToken, '/tables?page_size=200');
  const t = (j.data && j.data.items || []).find(x => x.name === name);
  return t ? t.table_id : '';
}
function fieldList(baseToken, tid) {
  const j = curlJson('GET', baseToken, `/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
  return (j.data && j.data.items) || [];
}

// ===== 1) 知识库「分类」选项：财富→职场 + 新增情绪管理 =====
console.log('===== 知识库：分类选项调整 =====');
const KB_TID = tidOf(BASE, '知识库');
if (!KB_TID) { console.error('❌ 未找到「知识库」表'); process.exit(1); }
const kbfields = fieldList(BASE, KB_TID);
const catField = kbfields.find(f => f.field_name === '分类');
if (!catField) {
  console.error('❌ 知识库无「分类」字段，跳过');
} else {
  const prop = catField.property || {};
  let opts = (prop.options || []).map(o => ({ id: o.id, name: o.name, ...(o.color ? { color: o.color } : {}) }));
  let renamed = false;
  opts.forEach(o => { if (o.name === '财富') { o.name = '职场'; renamed = true; } });
  if (renamed) console.log('  ↺ 选项「财富」→「职场」（保留 id，历史记录自动级联改名）');
  else if (!opts.find(o => o.name === '职场')) { opts.push({ name: '职场' }); console.log('  + 新增选项 职场'); }
  else console.log('  ↺ 选项「职场」已存在');
  if (!opts.find(o => o.name === '情绪管理')) { opts.push({ name: '情绪管理' }); console.log('  + 新增选项 情绪管理'); }
  else console.log('  ↺ 选项「情绪管理」已存在');
  if (!opts.find(o => o.name === '个人成长感悟')) { opts.push({ name: '个人成长感悟' }); console.log('  + 新增选项 个人成长感悟'); }
  else console.log('  ↺ 选项「个人成长感悟」已存在');
  const body = { field_name: '分类', type: 3, property: { options: opts } };
  if (prop.default_value) body.property.default_value = prop.default_value;
  const r = curlJson('PUT', BASE, `/tables/${encodeURIComponent(KB_TID)}/fields/${catField.field_id}`, body);
  if (r.code !== 0) console.error('  ⚠️ 更新分类字段失败', JSON.stringify(r).slice(0, 300));
  else console.log('  ✅ 分类字段更新成功');
}

// ===== 2) 人生灵感库：新增「标签」单选字段 =====
console.log('===== 人生灵感库：新增「标签」字段 =====');
const TAG_OPTS = ['职场', '女性成长', '人性', '健康', '心理学', '情绪管理', '个人成长感悟'];
const INSP_TID = /^tbl/.test(INSPIRE_TABLE) ? INSPIRE_TABLE : tidOf(INSPIRE_BASE, '人生灵感库');
const inspFields = fieldList(INSPIRE_BASE, INSP_TID);
if (inspFields.find(f => f.field_name === '标签')) {
  console.log('  ↺ 「标签」字段已存在，跳过');
} else {
  const r = curlJson('POST', INSPIRE_BASE, `/tables/${encodeURIComponent(INSP_TID)}/fields`, {
    field_name: '标签', type: 3, property: { options: TAG_OPTS.map(n => ({ name: n })) }
  });
  if (r.code !== 0) console.error('  ⚠️ 新增标签字段失败', JSON.stringify(r).slice(0, 300));
  else console.log('  ✅ 已新增「标签」单选字段，选项：' + TAG_OPTS.join('、'));
}

console.log('ALL DONE ✅');
