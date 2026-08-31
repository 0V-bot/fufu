#!/usr/bin/env node
// 一次性回填脚本：为「人生灵感库」文章记录新增分类 ID 字段，并建立「分类注册表」。
// 用法（在已具备飞书凭证的环境，如 VPS）：
//   cd ~/fufu
//   node tools/backfill-category-ids.js
// 幂等：已回填的记录、已存在的注册表节点都会跳过，可重复运行。
// 会自动加载同目录 .env（docker env_file 那份）中的飞书凭证，无需手动 export。
//
// 设计对应方案：文章记录新增 一级分类ID/二级分类ID/三级分类ID/内容类型ID（稳定引用），
// 指向「分类注册表」节点；后续改名/删除只动注册表，旧记录靠 ID 自动同步显示，零改写旧数据。

const fs = require('fs');
const path = require('path');

const WORKBENCH = path.join(__dirname, '..');

// 轻量 .env 加载（0 依赖）：docker 用 env_file 注入，但本脚本在宿主shell直跑，
// 需要自己读 /root/fufu/.env 把飞书凭证塞进 process.env。
function loadEnv() {
  const f = path.join(WORKBENCH, '.env');
  if (!fs.existsSync(f)) return;
  const txt = fs.readFileSync(f, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const FEISHU_API = 'https://open.feishu.cn/open-apis';
const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const INSPIRE_BASE = process.env.INSPIRE_BASE_TOKEN || 'ARCcbggiUaFqESsV7pRcin8CnUb';
const INSPIRE_TABLE = process.env.INSPIRE_TABLE || 'tblpI6WqsvA5z0CL';
const INPUT_TABLE = process.env.INPUT_TABLE || 'tblxVYnQ8P49qc6Y';
const REGISTRY_ENV = process.env.CATEGORY_REGISTRY_TABLE_TOKEN || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NET_RE = /network|EOF|transport|timeout|500|502|503|504/i;

// 简单并发池：items 分给 size 个 worker 协程，按序取任务
async function runPool(items, size, worker) {
  let idx = 0;
  const next = async () => { while (idx < items.length) { const cur = idx++; await worker(items[cur], cur); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

let _tok = '', _exp = 0;
async function tenantToken() {
  const now = Date.now();
  if (_tok && now < _exp - 60000) return _tok;
  const r = await fetch(FEISHU_API + '/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const j = await r.json();
  const tok = (j.data && j.data.tenant_access_token) || j.tenant_access_token;
  if (!tok) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(j).slice(0, 200));
  _tok = tok; _exp = now + ((j.data && j.data.expire) || j.expire || 7200) * 1000;
  return _tok;
}
async function fReq(method, p, body) {
  const tok = await tenantToken();
  let lastMsg = '';
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(FEISHU_API + p, {
        method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json();
      if (j.code === 0) return j;
      lastMsg = '飞书错误 code=' + j.code + ': ' + JSON.stringify(j).slice(0, 400);
      // 任何非 0 返回都退避重试（含频率限制 99991400/99991301 等），短而固定，避免指数膨胀拖垮总时长
      await sleep(Math.min(2000, 400 * (i + 1)));
      continue;
    } catch (e) {
      lastMsg = e.message || String(e);
      if (NET_RE.test(lastMsg)) { await sleep(600 * Math.pow(2, i)); continue; }
      throw e;
    }
  }
  throw new Error('fReq 重试耗尽: ' + lastMsg);
}
const _prefix = {};
async function basePrefix(baseToken) {
  if (_prefix[baseToken]) return _prefix[baseToken];
  for (const p of [`/bitable/v3/bases/${baseToken}`, `/bitable/v1/apps/${baseToken}`]) {
    try { const j = await fReq('GET', p + '/tables?page_size=1'); if (j.code === 0) { _prefix[baseToken] = p; return p; } } catch (e) {}
  }
  _prefix[baseToken] = `/bitable/v1/apps/${baseToken}`; return _prefix[baseToken];
}
async function tableId(name, baseToken) {
  const pre = await basePrefix(baseToken);
  const j = await fReq('GET', `${pre}/tables?page_size=200`);
  const m = {}; (j.data.items || []).forEach(t => { m[t.name] = t.table_id; });
  return m[name] || name;
}
async function listAll(tableToken, baseToken) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(tableToken, baseToken);
  const out = []; let pageToken = '';
  do {
    const url = `${pre}/tables/${encodeURIComponent(id)}/records?page_size=100${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
    const j = await fReq('GET', url);
    (j.data.items || []).forEach(it => out.push(Object.assign({ record_id: it.record_id }, it.fields || {})));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return out;
}
async function addField(tableToken, fieldName, type, baseToken) {
  const pre = await basePrefix(baseToken);
  const id = await tableId(tableToken, baseToken);
  // 关键：先单次探测字段是否已存在（不进入 fReq 重试循环，避免重复建字段触发重试风暴），
  // 存在则直接跳过。探测失败也不阻塞，走下面的 POST 兜底。
  try {
    const tok = await tenantToken();
    const res = await fetch(FEISHU_API + `${pre}/tables/${encodeURIComponent(id)}/fields?page_size=200`, {
      headers: { Authorization: 'Bearer ' + tok }
    });
    const j = await res.json();
    if (j.code === 0) {
      const names = (j.data.items || []).map(f => (f.field_name || '').toString());
      if (names.includes(fieldName)) return;
    }
  } catch (e) { /* 查失败不阻塞 */ }
  try { await fReq('POST', `${pre}/tables/${encodeURIComponent(tableToken)}/fields`, { field_name: fieldName, type }); }
  catch (e) { /* 已存在或不支持则忽略 */ }
}
async function ensureRegistry() {
  const localF = path.join(WORKBENCH, 'cat-registry.json');
  // 1) 优先用环境变量指定
  if (REGISTRY_ENV) { try { await listAll(REGISTRY_ENV, INSPIRE_BASE); return REGISTRY_ENV; } catch (e) {} }
  // 2) 读本地已记录的 token（避免重跑重复建表）
  if (fs.existsSync(localF)) {
    try {
      const tok = JSON.parse(fs.readFileSync(localF, 'utf8')).token;
      if (tok) { await listAll(tok, INSPIRE_BASE); return tok; }
    } catch (e) {}
  }
  // 3) 查是否已存在「分类注册表」表（名字匹配）
  try {
    const pre = await basePrefix(INSPIRE_BASE);
    const j = await fReq('GET', `${pre}/tables?page_size=200`);
    const found = (j.data.items || []).find(t => t.name === '分类注册表');
    if (found) {
      try { fs.writeFileSync(localF, JSON.stringify({ token: found.table_id })); } catch (e) {}
      console.log('✅ 复用已存在的分类注册表，token =', found.table_id);
      return found.table_id;
    }
  } catch (e) {}
  // 4) 最后才新建
  const pre = await basePrefix(INSPIRE_BASE);
  const j = await fReq('POST', `${pre}/tables`, { table: { name: '分类注册表' } });
  const tid = j.data.table_id;
  for (const f of [{ name: 'name', type: 1 }, { name: 'parentId', type: 1 }, { name: 'level', type: 1 }, { name: 'active', type: 7 }, { name: 'aliases', type: 1 }, { name: 'id', type: 1 }]) {
    await addField(tid, f.name, f.type, INSPIRE_BASE);
  }
  try { fs.writeFileSync(localF, JSON.stringify({ token: tid })); } catch (e) {}
  console.log('✅ 已创建分类注册表，token =', tid);
  return tid;
}

async function main() {
  if (!APP_ID || !APP_SECRET) { console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量'); process.exit(1); }
  const regTable = await ensureRegistry();
  console.log('➡️ 为文章表新增分类 ID 字段…');
  for (const t of [INSPIRE_TABLE, INPUT_TABLE]) {
    await addField(t, '一级分类ID', 1, INSPIRE_BASE);
    await addField(t, '二级分类ID', 1, INSPIRE_BASE);
    await addField(t, '三级分类ID', 1, INSPIRE_BASE);
    await addField(t, '内容类型ID', 1, INSPIRE_BASE);
  }

  console.log('➡️ 读取人生灵感库全量记录…');
  const rows = await listAll(INSPIRE_TABLE, INSPIRE_BASE);
  console.log('   共', rows.length, '条');

  const regPre = await basePrefix(INSPIRE_BASE);
  const regId = await tableId(regTable, INSPIRE_BASE);
  const regRows = await listAll(regTable, INSPIRE_BASE);
  // 第一遍：构建 id -> 节点 反查表（parentId 在飞书里存的是父节点 record_id）
  const idMap = {};
  regRows.forEach(r => {
    idMap[r.record_id] = {
      level: (r['level'] || '').toString(),
      name: (r['name'] || '').toString().trim(),
      parentId: (r['parentId'] || '').toString()
    };
  });
  // 第二遍：按 ensure() 写入时的同款 key 重建索引（从 parentId 反查父名，保证与创建时一致）
  // ensure 写入 key：L1='1::名'  L2='2::父名::名'  L3='3::祖父名::父名::名'  ctype='ctype::名'
  const regKey = {};
  regRows.forEach(r => {
    const node = idMap[r.record_id];
    if (!node || !node.name) return;
    const lvl = node.level;
    if (lvl === '1') regKey['1::' + node.name] = r.record_id;
    else if (lvl === '2') { const p = idMap[node.parentId]; if (p) regKey['2::' + p.name + '::' + node.name] = r.record_id; }
    else if (lvl === '3') { const p = idMap[node.parentId]; const gp = p ? idMap[p.parentId] : null; if (p && gp) regKey['3::' + gp.name + '::' + p.name + '::' + node.name] = r.record_id; }
    else if (lvl === 'ctype') regKey['ctype::' + node.name] = r.record_id;
  });
  console.log('   已读取注册表节点', regRows.length, '条，复用索引', Object.keys(regKey).length, '条');
  async function ensure(level, key, name, parentId) {
    if (regKey[key]) return regKey[key];
    try {
      const j = await fReq('POST', `${regPre}/tables/${encodeURIComponent(regId)}/records`, { fields: { name, parentId: parentId || '', level: String(level), active: true, id: '' } });
      const id = j.data.record.record_id;
      regKey[key] = id;
      return id;
    } catch (e) {
      console.error('   ⚠️ 建节点失败 [' + level + '] ' + name + '：' + e.message);
      return '';
    }
  }

  // —— 第一遍：建立/复用注册表节点（父级先于子级）——
  const l1Map = {}, l2Map = {}, l3Map = {}, ctypeMap = {};
  const l1set = new Set(), l2set = new Map(), l3set = new Map(), cset = new Set();
  const norm = v => (v == null ? '' : String(v)).toString().trim();
  for (const r of rows) {
    const c1 = norm(r['一级分类']), c2 = norm(r['二级分类']), c3 = norm(r['三级分类']), ct = norm(r['内容类型']);
    if (c1) l1set.add(c1);
    if (c1 && c2) l2set.set(c1 + '::' + c2, c2);
    if (c1 && c2 && c3) l3set.set(c1 + '::' + c2 + '::' + c3, c3);
    if (ct) cset.add(ct);
  }
  const l1arr = [...l1set], l2arr = [...l2set], l3arr = [...l3set], carr = [...cset];
  const nodeTot = l1arr.length + l2arr.length + l3arr.length + carr.length;
  let nodeDone = 0;
  const tick = () => { nodeDone++; if (nodeDone % 10 === 0 || nodeDone === nodeTot) console.log(`   建节点进度 ${nodeDone}/${nodeTot}`); };
  // 按层级并发（每级 8 路），父级整体先于子级，保证 parentId 从属关系正确
  await runPool(l1arr, 8, async (n) => { l1Map[n] = await ensure('1', '1::' + n, n, ''); tick(); });
  await runPool(l2arr, 8, async ([k, n]) => { const pid = l1Map[k.split('::')[0]]; l2Map[k] = await ensure('2', '2::' + k, n, pid); tick(); });
  await runPool(l3arr, 8, async ([k, n]) => { const [a, b] = k.split('::'); const pid = l2Map[a + '::' + b]; l3Map[k] = await ensure('3', '3::' + k, n, pid); tick(); });
  await runPool(carr, 8, async (n) => { ctypeMap[n] = await ensure('ctype', 'ctype::' + n, n, ''); tick(); });
  console.log(`   注册表节点：一级 ${l1set.size} / 二级 ${l2set.size} / 三级 ${l3set.size} / 内容类型 ${cset.size}`);

  // —— 第二遍：回填文章记录（并发池）——
  const artPre = await basePrefix(INSPIRE_BASE);
  const artId = await tableId(INSPIRE_TABLE, INSPIRE_BASE);
  let updated = 0, skipped = 0, errored = 0;
  async function updateOne(r) {
    try {
      const c1 = norm(r['一级分类']), c2 = norm(r['二级分类']), c3 = norm(r['三级分类']), ct = norm(r['内容类型']);
      const id1 = c1 ? (l1Map[c1] || '') : '';
      const id2 = (c1 && c2) ? (l2Map[c1 + '::' + c2] || '') : '';
      const id3 = (c1 && c2 && c3) ? (l3Map[c1 + '::' + c2 + '::' + c3] || '') : '';
      const idc = ct ? (ctypeMap[ct] || '') : '';
      const need = (c1 && !norm(r['一级分类ID'])) || (c2 && !norm(r['二级分类ID'])) || (c3 && !norm(r['三级分类ID'])) || (ct && !norm(r['内容类型ID']));
      if (!need) return 'skip';
      const fields = {};
      if (c1) fields['一级分类ID'] = id1;
      if (c2) fields['二级分类ID'] = id2;
      if (c3) fields['三级分类ID'] = id3;
      if (ct) fields['内容类型ID'] = idc;
      await fReq('PUT', `${artPre}/tables/${encodeURIComponent(artId)}/records/${r.record_id}`, { fields });
      return 'upd';
    } catch (e) {
      console.error('   ⚠️ 回填失败 ' + (r.record_id || '') + '：' + e.message);
      return 'err';
    }
  }
  // 简单并发池（8 路）
  const POOL = 8;
  for (let i = 0; i < rows.length; i += POOL) {
    const batch = rows.slice(i, i + POOL);
    const res = await Promise.all(batch.map(updateOne));
    res.forEach(x => { if (x === 'upd') updated++; else if (x === 'err') errored++; else skipped++; });
    if ((i + POOL) % 100 < POOL || i + POOL >= rows.length) console.log(`   进度 ${Math.min(i + POOL, rows.length)}/${rows.length}  已更新 ${updated} / 跳过 ${skipped} / 失败 ${errored}`);
  }
  console.log(`✅ 回填完成：更新 ${updated} 条，跳过(已回填) ${skipped} 条，失败 ${errored} 条`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ 回填失败：', e.message || e); process.exit(1); });
