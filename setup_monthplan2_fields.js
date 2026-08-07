#!/usr/bin/env node
/**
 * 月度计划2.0 —— 在「傅傅的工作台」主 Base 新建「月度计划」表（幂等，可重复执行）。
 * 字段（8 个）：
 *   1) 年份     type 2 (数字 / 整型)
 *   2) 月份     type 2 (数字 / 整型)
 *   3) 序号     type 2 (数字 / 整型)
 *   4) 计划事项 type 1 (文本)
 *   5) 计划内容 type 1 (文本)
 *   6) 截止时间 type 5 (日期，仅截取到日 yyyy-MM-dd)
 *   7) 完成标签 type 2 (数字，仅 0/1：0=未完成 1=已完成)
 *   8) 每日     type 7 (复选框：每日任务则勾选，无需截止时间)
 *
 * 用法（在 workbench 目录下执行）：
 *   node setup_monthplan2_fields.js
 * 需要 .env.local 或环境变量提供 FEISHU_APP_ID / FEISHU_APP_SECRET（可选 BASE_TOKEN）。
 * 已存在则跳过，不会重复建表或重复加字段。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- 读取凭证：优先环境变量，其次 .env.local ----
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

  // 探测 API 前缀（v3/bases 或 v1/apps）
  let PRE = null;
  for (const p of ['/bitable/v3/bases/' + BASE_TOKEN, '/bitable/v1/apps/' + BASE_TOKEN]) {
    try { const j = await req('GET', p + '/tables?page_size=1', null, token); if (j.code === 0) { PRE = p; break; } }
    catch (e) { /* 404 文本，试下一个 */ }
  }
  if (!PRE) throw new Error('无法确定 bitable API 前缀');
  console.log('✅ prefix =', PRE);

  const tl = await req('GET', PRE + '/tables?page_size=200', null, token);
  const tables = (tl.data && tl.data.items) || [];
  const findTable = n => tables.find(x => x.name === n);

  const TABLE_NAME = '月度计划';
  let tid;
  const existing = findTable(TABLE_NAME);
  if (existing) { tid = existing.table_id; console.log(`ℹ️ 表「${TABLE_NAME}」已存在 (${tid})`); }
  else {
    const cj = await req('POST', PRE + '/tables', { table: { name: TABLE_NAME } }, token);
    if (cj.code !== 0) throw new Error('建表失败: ' + JSON.stringify(cj).slice(0, 400));
    tid = cj.data.table_id;
    console.log(`✅ 已创建表「${TABLE_NAME}」(${tid})`);
  }

  const getFields = async () => ((await req('GET', PRE + '/tables/' + tid + '/fields?page_size=200', null, token)).data || {}).items || [];
  const fields = await getFields();
  const names = fields.map(f => f.field_name);
  console.log('\n现有字段:', names.join(', ') || '(无)');

  const FIELDS = [
    { name: '年份', type: 2 },
    { name: '月份', type: 2 },
    { name: '序号', type: 2 },
    { name: '计划事项', type: 1 },
    { name: '计划内容', type: 1 },
    { name: '截止时间', type: 5, property: { date_formatter: 'yyyy-MM-dd' } },
    { name: '完成标签', type: 2 },
    { name: '每日', type: 7 },
  ];
  for (const f of FIELDS) {
    if (names.includes(f.name)) { console.log('  ↺ ' + f.name + ' 已存在，跳过'); continue; }
    const body = { field_name: f.name, type: f.type };
    if (f.property) body.property = f.property;
    const r = await req('POST', PRE + '/tables/' + tid + '/fields', body, token);
    console.log('  ' + (r.code === 0 ? '✅' : '⚠️') + ' 新增字段 ' + f.name + ' (type ' + f.type + ')' + (r.code === 0 ? '' : JSON.stringify(r).slice(0, 200)));
  }

  console.log('\nALL DONE ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
