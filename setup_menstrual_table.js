#!/usr/bin/env node
/**
 * 创建「姨妈记录」多维表格并补齐字段（幂等，可重复执行）
 *   字段：日期(日期) / 流量(单选 多/中/少/无) / 备注(文本)
 *
 * 用法：在 workbench 目录下执行
 *   node setup_menstrual_table.js
 * 需要 .env.local 或环境变量提供 FEISHU_APP_ID / FEISHU_APP_SECRET（可选 BASE_TOKEN）
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

  let PRE = null;
  for (const p of ['/bitable/v3/bases/' + BASE_TOKEN, '/bitable/v1/apps/' + BASE_TOKEN]) {
    try { const j = await req('GET', p + '/tables?page_size=1', null, token); if (j.code === 0) { PRE = p; break; } }
    catch (e) { /* 试下一个 */ }
  }
  if (!PRE) throw new Error('无法确定 bitable API 前缀');
  console.log('✅ prefix =', PRE);

  const tl = await req('GET', PRE + '/tables?page_size=200', null, token);
  const tables = (tl.data && tl.data.items) || [];
  let ment = tables.find(x => x.name === '姨妈记录');
  if (ment) console.log('· 「姨妈记录」表已存在，table_id=', ment.table_id);
  else {
    const r = await req('POST', PRE + '/tables', { table: { name: '姨妈记录' } }, token);
    console.log('  建表响应:', JSON.stringify(r).slice(0, 300));
    if (r.code !== 0) throw new Error('建表失败: ' + JSON.stringify(r).slice(0, 200));
    ment = { table_id: r.data.table_id, name: '姨妈记录' };
    console.log('· 已创建「姨妈记录」表，table_id=', ment.table_id);
  }

  const getFields = async tid => ((await req('GET', PRE + '/tables/' + tid + '/fields?page_size=200', null, token)).data || {}).items || [];
  const fields = await getFields(ment.table_id);
  const names = fields.map(f => f.field_name);
  console.log('  现有字段:', names.join(', '));

  const want = [
    { name: '日期', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd' } },
    { name: '流量', type: 3, property: { options: [{ name: '多' }, { name: '中' }, { name: '少' }, { name: '无' }] } },
    { name: '备注', type: 1 },
  ];
  for (const w of want) {
    if (names.includes(w.name)) { console.log('  · 「' + w.name + '」已存在，跳过'); continue; }
    const body = { field_name: w.name, type: w.type };
    if (w.property) body.property = w.property;
    const r = await req('POST', PRE + '/tables/' + ment.table_id + '/fields', body, token);
    console.log('  · 新增「' + w.name + '」-> code=' + r.code + ' ' + (r.msg || ''));
  }

  console.log('\nALL DONE ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
