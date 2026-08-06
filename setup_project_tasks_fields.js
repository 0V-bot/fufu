#!/usr/bin/env node
/**
 * 项目任务表结构调整（幂等，可重复执行）。
 *
 * 目标结构：
 *   - 任务标题  (文本 type 1)   —— 由旧字段「任务」改名而来（保留历史数据）
 *   - 项目      (双向关联 type 18，保持不变)
 *   - ID        (数字 type 2)   —— 自增主键，由工作台代码维护 max+1
 *   - 上级任务标题 (文本 type 1) —— 思维导图父子层级依据
 *   - 任务内容  (文本 type 1)
 *   - 状态      (单选 type 3，保持不变)
 *   - 备注      (文本 type 1，保持不变)
 *
 * 用法（workbench 目录下）：
 *   node setup_project_tasks_fields.js
 * 需要 FEISHU_APP_ID / FEISHU_APP_SECRET（或 .env.local）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const env = Object.assign({}, process.env);
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(l => {
    const i = l.indexOf('=');
    if (i > 0) { const k = l.slice(0, i).trim(); if (!env[k]) env[k] = l.slice(i + 1).trim(); }
  });
}
const APP_ID = env.FEISHU_APP_ID, APP_SECRET = env.FEISHU_APP_SECRET;
const BASE_TOKEN = env.BASE_TOKEN || 'Wwtfbm66VaJyLOsBQaTcTm1vnHg';
if (!APP_ID || !APP_SECRET) { console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET'); process.exit(1); }

function req(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request({ hostname: 'open.feishu.cn', path: '/open-apis' + apiPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('HTTP ' + res.statusCode + ' 非 JSON: ' + buf.slice(0, 150))); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const t = await req('POST', '/auth/v3/tenant_access_token/internal', { app_id: APP_ID, app_secret: APP_SECRET });
  const token = (t.data && t.data.tenant_access_token) || t.tenant_access_token;
  if (!token) throw new Error('取 token 失败: ' + JSON.stringify(t));
  console.log('✅ token ok');

  // 探测 API 前缀
  let PRE = null;
  for (const p of ['/bitable/v3/bases/' + BASE_TOKEN, '/bitable/v1/apps/' + BASE_TOKEN]) {
    try { const j = await req('GET', p + '/tables?page_size=1', null, token); if (j.code === 0) { PRE = p; break; } } catch (e) { /* 试下一个 */ }
  }
  if (!PRE) throw new Error('无法确定 bitable API 前缀');
  console.log('✅ prefix =', PRE);

  const tl = await req('GET', PRE + '/tables?page_size=200', null, token);
  const tables = (tl.data && tl.data.items) || [];
  const findTable = n => tables.find(x => x.name === n);

  const TABLE_NAME = '项目任务';
  const existing = findTable(TABLE_NAME);
  if (!existing) throw new Error('未找到「' + TABLE_NAME + '」表，请先在飞书创建该表');
  const tid = existing.table_id;
  console.log(`ℹ️ 表「${TABLE_NAME}」(${tid})`);

  const getFields = async () => ((await req('GET', PRE + '/tables/' + tid + '/fields?page_size=200', null, token)).data || {}).items || [];
  const fields = await getFields();
  const byName = {};
  fields.forEach(f => byName[f.field_name] = f);
  console.log('\n现有字段:', fields.map(f => f.field_name).join(', '));

  // 1) 旧字段「任务」改名为「任务标题」（保留历史数据）
  if (byName['任务'] && !byName['任务标题']) {
    const f = byName['任务'];
    const body = { field_name: '任务标题', type: f.type };
    if (f.property) body.property = f.property;
    const r = await req('PUT', PRE + '/tables/' + tid + '/fields/' + f.field_id, body, token);
    console.log('  ' + (r.code === 0 ? '✅' : '⚠️') + ' 重命名「任务」→「任务标题」' + (r.code === 0 ? '' : ' ' + JSON.stringify(r).slice(0, 200)));
  } else if (byName['任务标题']) {
    console.log('  ↺ 字段「任务标题」已存在，跳过改名');
  } else {
    console.log('  ℹ️ 无「任务」字段，将直接新建「任务标题」');
  }

  // 刷新字段缓存
  const fields2 = await getFields();
  const names2 = fields2.map(f => f.field_name);

  // 2) 新增字段（幂等）
  const ADD = [
    { name: 'ID', type: 2 },
    { name: '上级任务标题', type: 1 },
    { name: '任务内容', type: 1 },
  ];
  for (const f of ADD) {
    if (names2.includes(f.name)) { console.log('  ↺ ' + f.name + ' 已存在，跳过'); continue; }
    const r = await req('POST', PRE + '/tables/' + tid + '/fields', { field_name: f.name, type: f.type }, token);
    console.log('  ' + (r.code === 0 ? '✅' : '⚠️') + ' 新增字段 ' + f.name + ' (type ' + f.type + ')' + (r.code === 0 ? '' : ' ' + JSON.stringify(r).slice(0, 200)));
  }

  console.log('\nALL DONE ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
