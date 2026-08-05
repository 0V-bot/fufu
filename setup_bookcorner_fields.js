#!/usr/bin/env node
/**
 * 精神角落表结构调整（幂等，可重复执行）
 *   1. 新增「链接」文本字段（记录书籍/资源的链接地址）
 *   2. 删除「评分」字段（产品上已去掉评分）
 *   3. 顺带校验「年度计划.类型」是否含「分组」选项，缺失则用 PUT 补齐
 *
 * 用法：在 workbench 目录下执行
 *   node setup_bookcorner_fields.js
 * 需要 .env.local 或环境变量提供 FEISHU_APP_ID / FEISHU_APP_SECRET（可选 BASE_TOKEN）
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
  const getFields = async tid => ((await req('GET', PRE + '/tables/' + tid + '/fields?page_size=200', null, token)).data || {}).items || [];

  /* ---------- 1 & 2：精神角落 ---------- */
  const book = findTable('精神角落');
  if (!book) { console.error('❌ 未找到「精神角落」表'); }
  else {
    const fields = await getFields(book.table_id);
    const names = fields.map(f => f.field_name);
    console.log('\n[精神角落] 现有字段:', names.join(', '));

    if (names.includes('链接')) console.log('  · 「链接」已存在，跳过');
    else {
      const r = await req('POST', PRE + '/tables/' + book.table_id + '/fields', { field_name: '链接', type: 1 }, token);
      console.log('  · 新增「链接」-> code=' + r.code + ' ' + (r.msg || ''));
    }

    const rating = fields.find(f => f.field_name === '评分');
    if (!rating) console.log('  · 「评分」不存在，跳过删除');
    else {
      const r = await req('DELETE', PRE + '/tables/' + book.table_id + '/fields/' + rating.field_id, null, token);
      console.log('  · 删除「评分」-> code=' + r.code + ' ' + (r.msg || ''));
    }

    const after = (await getFields(book.table_id)).map(f => f.field_name);
    console.log('  · 调整后字段:', after.join(', '));
  }

  /* ---------- 3：年度计划「类型」补「分组」选项 ---------- */
  // 注意：飞书没有 POST /fields/{id}/options 接口（404），
  // 追加单选选项必须用 PUT 整个字段并带上「全量」选项（已有的要带 id，新的只给 name）。
  const annual = findTable('年度计划');
  if (annual) {
    const fields = await getFields(annual.table_id);
    const typeField = fields.find(f => f.field_name === '类型');
    if (typeField) {
      const opts = (typeField.property && typeField.property.options) || [];
      console.log('\n[年度计划.类型] 现有选项:', opts.map(o => o.name).join(','));
      if (opts.some(o => o.name === '分组')) console.log('  · 「分组」已存在，跳过');
      else {
        const next = opts.map(o => ({ id: o.id, name: o.name })).concat([{ name: '分组' }]);
        const r = await req('PUT', PRE + '/tables/' + annual.table_id + '/fields/' + typeField.field_id,
          { field_name: '类型', type: 3, property: { options: next } }, token);
        console.log('  · 追加「分组」-> code=' + r.code + ' ' + (r.msg || ''));
      }
    }
  }

  console.log('\nALL DONE ✅');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
