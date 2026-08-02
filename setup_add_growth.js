#!/usr/bin/env node
// 幂等脚本：给三个飞书单选字段追加「个人成长感悟」选项：
//   1) 知识库.分类
//   2) 人生灵感库.标签 (fldMpMR4ac)
//   3) 录入表.标签 (fldR1Gc84n)
// 用法： node ./setup_add_growth.js
//   （自动读取 .env.local 的 FEISHU_APP_ID/SECRET；BASE_TOKEN / INSPIRE_BASE_TOKEN / INSPIRE_TABLE / INPUT_TABLE 可用环境变量覆盖）
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

function tidOf(baseToken, name) {
  const j = curlJson('GET', baseToken, '/tables?page_size=200');
  const t = (j.data && j.data.items || []).find(x => x.name === name);
  return t ? t.table_id : '';
}
function fieldList(baseToken, tid) {
  const j = curlJson('GET', baseToken, `/tables/${encodeURIComponent(tid)}/fields?page_size=200`);
  return (j.data && j.data.items) || [];
}
// 给指定单选字段追加一个选项（幂等：已存在则跳过）。返回 true 表示本次新增了选项。
function addOption(baseToken, tableId, fieldName, newName) {
  const fields = fieldList(baseToken, tableId);
  const f = fields.find(x => x.field_name === fieldName);
  if (!f) { console.error(`  ⚠️ 未找到字段「${fieldName}」`); return false; }
  const prop = f.property || {};
  let opts = (prop.options || []).map(o => ({ id: o.id, name: o.name, ...(o.color ? { color: o.color } : {}) }));
  if (opts.find(o => o.name === newName)) { console.log(`  ↺ 「${fieldName}」已含选项「${newName}」，跳过`); return false; }
  opts.push({ name: newName });
  const body = { field_name: fieldName, type: 3, property: { options: opts } };
  if (prop.default_value) body.property.default_value = prop.default_value;
  const r = curlJson('PUT', baseToken, `/tables/${encodeURIComponent(tableId)}/fields/${f.field_id}`, body);
  if (r.code !== 0) { console.error(`  ⚠️ 更新「${fieldName}」失败`, JSON.stringify(r).slice(0, 300)); return false; }
  console.log(`  ✅ 「${fieldName}」已新增选项「${newName}」`);
  return true;
}

const NEW = '个人成长感悟';
console.log('===== 追加「个人成长感悟」选项 =====');
const KB_TID = tidOf(BASE, '知识库');
if (KB_TID) addOption(BASE, KB_TID, '分类', NEW);
else console.error('  ⚠️ 未找到「知识库」表');

const INSP_TID = /^tbl/.test(INSPIRE_TABLE) ? INSPIRE_TABLE : tidOf(INSPIRE_BASE, '人生灵感库');
addOption(INSPIRE_BASE, INSP_TID, '标签', NEW);

const INPUT_TID = /^tbl/.test(INPUT_TABLE) ? INPUT_TABLE : tidOf(INSPIRE_BASE, '录入表');
addOption(INSPIRE_BASE, INPUT_TID, '标签', NEW);

console.log('ALL DONE ✅');
