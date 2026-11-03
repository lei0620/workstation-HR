#!/usr/bin/env node
/*
  HR 工作台 · 通知服务（短信 + 邮件）
  作用：网页本身不能直接发短信和邮件，这个小程序在你电脑上帮它转发。不需要安装任何依赖。

  用法：
    1. 电脑装好 Node.js（https://nodejs.org，选 LTS 版本）
    2. 在这个文件所在的文件夹打开终端，运行：node notify-server.js
       第一次运行会生成 notify-config.json，用记事本打开填好后，再运行一次
    3. 在工作台「设置 → 短信 / 邮件通知」里，把发送方式改成「通知接口自动发送」，
       接口地址填 http://127.0.0.1:8790/send，点「发一条测试」

  邮件：支持 QQ 邮箱、163 邮箱、腾讯企业邮、阿里企业邮等任何 SMTP 邮箱。
        密码处填「授权码」（在邮箱网页版 设置 → 账户 → 开启 SMTP 服务 后获得），不是登录密码。
  短信：使用阿里云短信服务。国内短信必须先在阿里云审核通过「签名」和「模板」，
        然后把每种通知对应的模板 Code（形如 SMS_123456789）填进配置。
        模板里的变量请用：name 姓名、job 职位、company 公司简称、time 时间、place 地点、
        mode 方式、round 面试轮次、date 到岗日期、phone 联系电话。

  只在本机 127.0.0.1 上监听，别的电脑访问不到。
  Developed by @赛博老爸
*/
'use strict';
const http = require('http'), https = require('https'), net = require('net'), tls = require('tls'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');

const CFG_PATH = path.join(__dirname, 'notify-config.json');
const LOG_PATH = path.join(__dirname, 'notify-log.txt');
const SAMPLE = {
  port: 8790,
  token: '',
  _token说明: '选填。填了以后，工作台设置里的「接口口令」要填一样的',
  email: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '你的邮箱@qq.com',
    pass: '邮箱授权码（不是登录密码）',
    fromName: '某某科技 人力资源部',
    _说明: '163 邮箱 host 填 smtp.163.com；腾讯企业邮 smtp.exmail.qq.com；阿里企业邮 smtp.qiye.aliyun.com。端口 465 配 secure: true；用 587 端口时把 secure 改成 false（会自动走 STARTTLS 加密）'
  },
  sms: {
    enabled: false,
    provider: 'aliyun',
    accessKeyId: '',
    accessKeySecret: '',
    signName: '某某科技',
    templates: { screen_pass: '', screen_fail: '', test_invite: '', iv_invite: '', hire_pass: '', final_fail: '', test: '' },
    _说明: 'templates 里填阿里云审核通过的模板 Code。模板变量名请用 name、job、company、time、place、mode、round、date、phone。test 是「发一条测试」用的模板，不填就用 screen_pass 的'
  },
  dryRun: false,
  _dryRun说明: '改成 true 时只记日志、不真正发送，用来先把流程跑通'
};

if (!fs.existsSync(CFG_PATH)) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(SAMPLE, null, 2), 'utf8');
  console.log('已生成配置文件：' + CFG_PATH);
  console.log('用记事本打开，把邮箱 / 短信信息填好、把 enabled 改成 true，保存后再运行一次：node notify-server.js');
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { console.error('notify-config.json 格式不对（注意英文引号和逗号）：' + e.message); process.exit(1); }

function log(line) { try { fs.appendFileSync(LOG_PATH, new Date().toLocaleString('zh-CN', { hour12: false }) + '  ' + line + os.EOL, 'utf8'); } catch (e) { } }
function maskTo(t) { t = String(t || ''); return /@/.test(t) ? t.replace(/^(.).*?(.)@/, '$1***$2@') : t.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2'); }

/* ---------------- 邮件：SMTP（465 直接加密，或 587/25 走 STARTTLS） ---------------- */
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function encWord(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?='; }
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n'); }
function smtpSend(o, to, subject, text) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiter = null, done = false;
    const timer = setTimeout(() => fail(new Error('连接邮件服务器超时')), 25000);
    function fail(e) { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch (x) { } reject(e); }
    function ok(v) { if (done) return; done = true; clearTimeout(timer); try { sock && sock.end(); } catch (x) { } resolve(v); }
    function onData(d) { buf += d.toString('utf8'); flush(); }
    function flush() {
      if (!waiter) return;
      const m = buf.match(/^(?:\d{3}-[^\r\n]*\r?\n)*\d{3}(?: [^\r\n]*)?\r?\n/);
      if (m) { buf = buf.slice(m[0].length); const w = waiter; waiter = null; w(m[0]); }
    }
    function read() { return new Promise(r => { waiter = r; flush(); }); }
    async function cmd(line, expect, what) {
      if (line !== null) sock.write(line + '\r\n');
      const r = await read(), code = +r.slice(0, 3);
      if (expect.indexOf(code) < 0) throw new Error((what || 'SMTP') + '失败：' + r.trim().replace(/\r?\n/g, ' '));
      return r;
    }
    function attach(s) { sock = s; s.on('data', onData); s.on('error', fail); s.on('close', () => { if (!done) fail(new Error('邮件服务器断开了连接')); }); }
    const port = +o.port || 465, secure = o.secure !== false && port === 465 || o.secure === true;
    const opts = { host: o.host, port: port, servername: o.host };
    attach(secure ? tls.connect(opts) : net.connect(opts));
    (async () => {
      try {
        await cmd(null, [220], '连接邮件服务器');
        let ehlo = await cmd('EHLO hr-workbench.local', [250], 'EHLO');
        if (!secure && /STARTTLS/i.test(ehlo)) {
          await cmd('STARTTLS', [220], 'STARTTLS');
          sock.removeListener('data', onData);
          const old = sock; old.removeAllListeners('close'); old.removeAllListeners('error');
          await new Promise((res, rej) => { const t = tls.connect({ socket: old, servername: o.host }, res); t.once('error', rej); attach(t); });
          ehlo = await cmd('EHLO hr-workbench.local', [250], 'EHLO');
        }
        if (o.user) {
          await cmd('AUTH LOGIN', [334], '登录');
          await cmd(b64(o.user), [334], '登录（账号）');
          await cmd(b64(o.pass || ''), [235], '登录（授权码）');
        }
        await cmd('MAIL FROM:<' + o.user + '>', [250], '发件人');
        await cmd('RCPT TO:<' + to + '>', [250, 251], '收件人');
        await cmd('DATA', [354], 'DATA');
        const id = crypto.randomBytes(8).toString('hex') + '@hr-workbench';
        const msg = [
          'From: ' + encWord(o.fromName || o.user) + ' <' + o.user + '>',
          'To: <' + to + '>',
          'Subject: ' + encWord(subject || '(无主题)'),
          'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
          'Message-ID: <' + id + '>',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          wrap76(b64(String(text || '').replace(/\r?\n/g, '\r\n')))
        ].join('\r\n');
        await cmd(msg + '\r\n.', [250], '发送邮件');
        try { sock.write('QUIT\r\n'); } catch (e) { }
        ok(true);
      } catch (e) { fail(e); }
    })();
  });
}

/* ---------------- 短信：阿里云 SendSms（RPC 签名 v1） ---------------- */
function pe(s) { return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function aliyunSign(params, secret, method) {
  const keys = Object.keys(params).sort();
  const canon = keys.map(k => pe(k) + '=' + pe(params[k])).join('&');
  const sts = (method || 'GET') + '&' + pe('/') + '&' + pe(canon);
  return { canon: canon, sig: crypto.createHmac('sha1', secret + '&').update(sts).digest('base64') };
}
function aliyunSms(o, phone, templateCode, vars) {
  const params = {
    AccessKeyId: o.accessKeyId, Action: 'SendSms', Format: 'JSON', PhoneNumbers: phone, RegionId: 'cn-hangzhou', SignName: o.signName,
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'), SignatureVersion: '1.0',
    TemplateCode: templateCode, TemplateParam: JSON.stringify(vars || {}), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-05-25'
  };
  const s = aliyunSign(params, o.accessKeySecret);
  const url = 'https://dysmsapi.aliyuncs.com/?Signature=' + pe(s.sig) + '&' + s.canon;
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) { }
        if (j && j.Code === 'OK') resolve(j); else reject(new Error('阿里云返回：' + (j ? j.Code + ' ' + j.Message : d.slice(0, 120))));
      });
    }).on('error', e => reject(new Error('连不上阿里云：' + e.message))).setTimeout(15000, function () { this.destroy(new Error('请求阿里云超时')); });
  });
}

/* ---------------- 分发 ---------------- */
async function dispatch(p) {
  const ch = p.channel, to = String(p.to || '').trim();
  if (!to) throw new Error('缺少收件人');
  if (ch === 'email') {
    const o = cfg.email || {};
    if (!o.enabled) throw new Error('邮件没有启用：在 notify-config.json 里把 email.enabled 改成 true');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('邮箱格式不对：' + to);
    if (cfg.dryRun) return 'dry-run';
    await smtpSend(o, to, p.subject, p.content);
    return 'sent';
  }
  if (ch === 'sms') {
    const o = cfg.sms || {};
    if (!o.enabled) throw new Error('短信没有启用：在 notify-config.json 里把 sms.enabled 改成 true');
    const phone = to.replace(/[\s-]/g, '').replace(/^\+?86/, '');
    if (!/^1\d{10}$/.test(phone)) throw new Error('手机号格式不对：' + to);
    const tpl = (o.templates || {})[p.event] || (p.event === 'test' ? (o.templates || {}).screen_pass : '');
    if (!tpl) throw new Error('没有给「' + (p.eventName || p.event) + '」配置阿里云短信模板 Code');
    if (cfg.dryRun) return 'dry-run';
    if ((o.provider || 'aliyun') !== 'aliyun') throw new Error('暂时只支持阿里云短信');
    await aliyunSms(o, phone, tpl, p.vars || {});
    return 'sent';
  }
  throw new Error('不认识的渠道：' + ch);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') { json(200, { ok: true, name: 'HR 工作台通知服务', email: !!(cfg.email && cfg.email.enabled), sms: !!(cfg.sms && cfg.sms.enabled), dryRun: !!cfg.dryRun }); return; }
  if (req.method !== 'POST' || !/^\/send\/?$/.test(req.url.split('?')[0])) { json(404, { ok: false, error: '地址不对，应该是 /send' }); return; }
  if (cfg.token && (req.headers.authorization || '') !== 'Bearer ' + cfg.token) { json(401, { ok: false, error: '接口口令不对' }); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => {
    let p; try { p = JSON.parse(body); } catch (e) { json(400, { ok: false, error: '请求格式不对' }); return; }
    try {
      const r = await dispatch(p);
      log((r === 'dry-run' ? '[演练] ' : '') + (p.channel === 'sms' ? '短信' : '邮件') + ' ' + (p.eventName || p.event || '') + ' → ' + maskTo(p.to) + (p.name ? '（' + p.name + '）' : '') + ' 成功');
      json(200, { ok: true, result: r });
    } catch (e) {
      log((p.channel === 'sms' ? '短信' : '邮件') + ' ' + (p.eventName || p.event || '') + ' → ' + maskTo(p.to) + ' 失败：' + e.message);
      json(200, { ok: false, error: e.message });
    }
  });
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口 ' + (cfg.port || 8790) + ' 被占用了：可能已经开着一个，或者改一下配置里的 port' : e.message); process.exit(1); });
server.listen(+cfg.port || 8790, '127.0.0.1', () => {
  console.log('HR 工作台通知服务已启动：http://127.0.0.1:' + (+cfg.port || 8790) + '/send');
  console.log('邮件：' + (cfg.email && cfg.email.enabled ? '已启用（' + cfg.email.host + '）' : '未启用') + '；短信：' + (cfg.sms && cfg.sms.enabled ? '已启用（阿里云）' : '未启用') + (cfg.dryRun ? '；当前是演练模式，不会真正发送' : ''));
  console.log('发送记录保存在 notify-log.txt。关闭这个窗口就停止服务。');
});
module.exports = { aliyunSign: aliyunSign, smtpSend: smtpSend, pe: pe };
