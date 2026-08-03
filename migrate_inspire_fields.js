#!/usr/bin/env node
// 人生灵感库字段结构调整（OpenAPI 模式，幂等、破坏性操作的双保险）：
//   1) 删除 4 个字段：情绪标签 / 改写方向 / 适用场景 / 版权备注（⚠️ 删除会永久清除这些字段及其数据）
//   2) 把「使用状态」(select 单) 改名为「是否整理」，并把选项
//        未使用 → 未整理
//        已使用 → 已整理
//      （保留原 option_id，避免单元格绑定失效）
//   3) 双保险数据迁移：遍历人生灵感库全部记录，凡「是否整理」仍为旧值
//        {未使用,已使用,待分析} 的，按映射改写为 {未整理,已整理,未整理}。
//      若飞书按 option_id 存储，改名后旧记录已自动跟随新名，本步为空操作（安全）；
//      若按 name 存储，本步补齐，确保筛选/显示一致。
// 用法： node ./migrate_inspire_fields.js
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
const BASE = process.env.INSPIRE_BASE_TOKEN || 'ARCcbggiUaFqESsV7pRcin8CnUb';
const TABLE = process.env.INSPIRE_TABLE || 'tblpI6WqsvA5z0CL';
if (!APP_ID || !APP_SECRET) { console.error('❌ 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET'); process.exit(1); }

const API = 'https://open.feishu.cn/open-apis';
const REQ = '_mig_req_tmp.json';
const OUT = '_mig_out.json';
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

// ---- 字段列表 ----
function fieldList() {
  const j = curlJson('GET', `/tables/${encodeURIComponent(TABLE)}/fields?page_size=200`);
  return (j.data && j.data.items) || [];
}
function delField(fid) {
  const j = curlJson('DELETE', `/tables/${encodeURIComponent(TABLE)}/fields/${fid}`);
  return j.code === 0;
}
function putField(fid, body) {
  const j = curlJson('PUT', `/tables/${encodeURIComponent(TABLE)}/fields/${fid}`, body);
  if (j.code !== 0) console.log('    ⚠️ PUT 返回:', JSON.stringify(j).slice(0, 400));
  return j.code === 0;
}

const fields = fieldList();
console.log(`\n现有字段数：${fields.length}`);

// ===== 1) 删除 4 个字段 =====
const DEL = ['情绪标签', '改写方向', '适用场景', '版权备注'];
console.log('\n===== 删除 4 个字段 =====');
DEL.forEach(name => {
  const f = fields.find(x => x.field_name === name);
  if (!f) { console.log(`  ↺ ${name} 不存在，跳过`); return; }
  const ok = delField(f.field_id);
  console.log(`  ${ok ? '✅' : '⚠️'} 删除 ${name} (${f.field_id}) ${ok ? '' : '失败'}`);
});

// ===== 2) 改名「使用状态」→「是否整理」 + 改选项 =====
console.log('\n===== 改名「使用状态」→「是否整理」并改选项 =====');
const statusField = fields.find(x => x.field_name === '使用状态');
if (!statusField) {
  console.log('  ⚠️ 未找到「使用状态」字段（可能已改名），跳过改名步骤');
} else {
  const opts = (statusField.property && statusField.property.options) || [];
  // 保留原 option_id；未使用→未整理、已使用→已整理；丢弃「待分析」（最终选项仅 未整理/已整理）
  const newOptions = opts
    .filter(o => o.name !== '待分析')
    .map(o => ({ id: o.id, name: ({ '未使用': '未整理', '已使用': '已整理' }[o.name] || o.name) }));
  const ok = putField(statusField.field_id, { field_name: '是否整理', type: 3, property: { options: newOptions } });
  console.log(`  ${ok ? '✅' : '⚠️'} 改名 使用状态→是否整理；选项 未使用→未整理 / 已使用→已整理 ${ok ? '' : '失败'}`);
}

// ===== 3) 双保险数据迁移 =====
const MAP = { '未使用': '未整理', '已使用': '已整理', '待分析': '未整理' };
console.log('\n===== 双保险：迁移仍为旧值的记录 =====');
let pageToken = '';
let total = 0, migrated = 0;
do {
  let url = `/tables/${encodeURIComponent(TABLE)}/records?page_size=500`;
  if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
  const j = curlJson('GET', url);
  const items = (j.data && j.data.items) || [];
  for (const rec of items) {
    total++;
    const cur = rec.fields && rec.fields['是否整理'];
    if (cur && MAP[cur]) {
      const nv = MAP[cur];
      const u = curlJson('PUT', `/tables/${encodeURIComponent(TABLE)}/records/${rec.record_id}`, { fields: { '是否整理': nv } });
      if (u.code === 0) migrated++; else console.log(`  ⚠️ 记录 ${rec.record_id} 迁移失败: ${JSON.stringify(u).slice(0,120)}`);
    }
  }
  pageToken = (j.data && j.data.has_more && j.data.page_token) || '';
} while (pageToken);
console.log(`  扫描 ${total} 条，迁移 ${migrated} 条`);

console.log('\nALL DONE ✅');
