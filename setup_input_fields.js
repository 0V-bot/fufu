#!/usr/bin/env node
// 一次性表结构变更脚本（OpenAPI 模式，幂等）：
//   给「录入表」(tblxVYnQ8P49qc6Y，位于 人生研究学院 Base) 新增 4 个单选字段：
//     一级分类 / 二级分类 / 三级分类 / 标签
//   选项分别来自：
//     一级分类 ← category.json 的 cat1（14 项）
//     二级分类 ← category.json 所有二级（73 项）
//     三级分类 ← category.json 所有三级（16 项）
//     标签     ← WISDOM_TAGS（职场/女性成长/人性/健康/心理学/情绪管理）
//   同时回读「人生灵感库」的「标签」字段 ID（供 skill 映射使用）。
// 用法： node ./setup_input_fields.js
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
const INSPIRE_TABLE = process.env.INSPIRE_TABLE || 'tblpI6WqsvA5z0CL';
const WISDOM_TAGS = ['职场', '女性成长', '人性', '健康', '心理学', '情绪管理', '个人成长感悟'];
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
function createField(baseToken, tid, name, options) {
  return curlJson('POST', baseToken, `/tables/${encodeURIComponent(tid)}/fields`, {
    field_name: name, type: 3, property: { options: options.map(n => ({ name: n })) }
  });
}

// ---- 从 category.json 聚合分类选项 ----
let cat1 = [], tree = {};
try {
  const cj = JSON.parse(fs.readFileSync('category.json', 'utf8'));
  cat1 = cj.cat1 || [];
  tree = cj.tree || {};
} catch (e) { console.error('⚠️ 读取 category.json 失败，分类选项将留空：', e.message); }
const cat2 = [], cat3 = [];
Object.keys(tree).forEach(a => {
  Object.keys(tree[a]).forEach(b => {
    if (!cat2.includes(b)) cat2.push(b);
    (tree[a][b] || []).forEach(c => { if (c && !cat3.includes(c)) cat3.push(c); });
  });
});
console.log(`分类选项聚合：一级=${cat1.length} 二级=${cat2.length} 三级=${cat3.length}`);

// ===== 录入表：新增 4 个单选字段 =====
console.log('===== 录入表：新增 4 个分类/标签字段 =====');
const fields = fieldList(INSPIRE_BASE, INPUT_TABLE);
const want = [
  { name: '一级分类', opts: cat1 },
  { name: '二级分类', opts: cat2 },
  { name: '三级分类', opts: cat3 },
  { name: '标签', opts: WISDOM_TAGS },
];
const newIds = {};
want.forEach(w => {
  const ex = fields.find(f => f.field_name === w.name);
  if (ex) { console.log(`  ↺ ${w.name} 已存在 (${ex.field_id})，跳过`); newIds[w.name] = ex.field_id; return; }
  const r = createField(INSPIRE_BASE, INPUT_TABLE, w.name, w.opts);
  if (r.code !== 0) { console.error(`  ⚠️ 新增 ${w.name} 失败`, JSON.stringify(r).slice(0, 300)); return; }
  const id = (r.data && r.data.field_id) || (r.data && r.data.field && r.data.field.field_id) || '';
  newIds[w.name] = id;
  console.log(`  ✅ 新增 ${w.name} (${id})，选项 ${w.opts.length} 个`);
});

// ===== 人生灵感库：回读「标签」字段 ID =====
console.log('===== 人生灵感库：回读「标签」字段 ID =====');
const inspFields = fieldList(INSPIRE_BASE, INSPIRE_TABLE);
const tagField = inspFields.find(f => f.field_name === '标签');
if (!tagField) {
  console.log('  ⚠️ 人生灵感库无「标签」字段（skill 映射里需补建），跳过');
} else {
  console.log(`  ✅ 人生灵感库 标签 字段 ID = ${tagField.field_id}`);
}

console.log('\n===== 字段 ID 汇总（用于更新 skill 映射）=====');
console.log(JSON.stringify({ 录入表: newIds, 人生灵感库标签: tagField ? tagField.field_id : null }, null, 2));
console.log('ALL DONE ✅');
