#!/usr/bin/env node
/**
 * 灵感记录 —— 在「灵感记录」表追加「尺寸」文本字段（幂等，可重复执行）。
 * 该字段用于持久保存每张灵感卡片的宽高（如 "300x200"），实现跨设备同步。
 *
 * 用法（在 workbench 目录下执行）：
 *   node setup_insprec_size_field.js
 * 需要 .env.local 或环境变量提供 FEISHU_APP_ID / FEISHU_APP_SECRET（可选 BASE_TOKEN）。
 * 列已存在则跳过。不执行也可正常使用：尺寸会保存在浏览器本地（IndexedDB），只是不同步到飞书。
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
    catch (e) { /* 404 文本，试下一个 */ }
  }
  if (!PRE) throw new Error('无法确定 bitable API 前缀');
  console.log('✅ prefix =', PRE);

  const tl = await req('GET', PRE + '/tables?page_size=200', null, token);
  const tables = (tl.data && tl.data.items) || [];
  const TABLE_NAME = process.env.INSP_TABLE || '灵感记录';
  const existing = tables.find(x => x.name === TABLE_NAME);
  if (!existing) throw new Error('找不到表「' + TABLE_NAME + '」，请确认 BASE_TOKEN 与表名');
  const tid = existing.table_id;
  console.log(`ℹ️ 表「${TABLE_NAME}」(${tid})`);

  const fields = ((await req('GET', PRE + '/tables/' + tid + '/fields?page_size=200', null, token)).data || {}).items || [];
  const names = fields.map(f => f.field_name);
  console.log('现有字段:', names.join(', ') || '(无)');

  const FIELDS = [{ name: '尺寸', type: 1 }];
  for (const f of FIELDS) {
    if (names.includes(f.name)) { console.log('  ↺ ' + f.name + ' 已存在，跳过'); continue; }
    const r = await req('POST', PRE + '/tables/' + tid + '/fields', { field_name: f.name, type: f.type }, token);
    console.log('  ' + (r.code === 0 ? '✅' : '⚠️') + ' 新增字段 ' + f.name + ' (type ' + f.type + ')' + (r.code === 0 ? '' : JSON.stringify(r).slice(0, 200)));
  }

  console.log('\nALL DONE ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
