/*
  HR 工作台 · 本地 AI 中转
  作用：有些 AI 服务商不允许网页直接调用（跨域限制），用这个小程序在本机转一下。
  用法：
    1. 电脑装好 Node.js（https://nodejs.org）
    2. 在这个文件所在的文件夹打开终端，运行：node ai-proxy.js
    3. 在「设置 → AI 接口」里，把接口地址改成 http://127.0.0.1:8787/ 加原来的地址
       例如：http://127.0.0.1:8787/https://api.deepseek.com
  只在本机 127.0.0.1 上监听，只转发到下面列出的 AI 服务地址。
  需要转发到其他地址时，启动前设置环境变量 ALLOW_HOSTS，多个用逗号隔开，例如：
    ALLOW_HOSTS=my-oneapi.example.com node ai-proxy.js
  Developed by @赛博老爸
*/
const http = require('http'), https = require('https');
const PORT = +process.env.PORT || 8787;
const ALLOW = ['api.deepseek.com', 'dashscope.aliyuncs.com', 'api.moonshot.cn', 'open.bigmodel.cn', 'ark.cn-beijing.volces.com', 'api.siliconflow.cn', 'api.openai.com', 'api.anthropic.com', 'localhost', '127.0.0.1']
  .concat(String(process.env.ALLOW_HOSTS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean));

http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  var target = req.url.slice(1), u;
  try { u = new URL(target); } catch (e) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('用法：把接口地址写成 http://127.0.0.1:' + PORT + '/https://api.deepseek.com'); return;
  }
  if (ALLOW.indexOf(u.hostname) < 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('这个地址不在允许列表里：' + u.hostname + '。需要的话启动时加 ALLOW_HOSTS=' + u.hostname); return;
  }
  var headers = Object.assign({}, req.headers);
  delete headers.host; delete headers.origin; delete headers.referer;
  var lib = u.protocol === 'https:' ? https : http;
  var up = lib.request(u, { method: req.method, headers: headers }, function (r) {
    var h = Object.assign({}, r.headers); h['access-control-allow-origin'] = '*';
    res.writeHead(r.statusCode || 502, h); r.pipe(res);
  });
  up.on('error', function (e) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('中转失败：' + e.message); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', function () { console.log('AI 中转已启动：http://127.0.0.1:' + PORT + '/  （关闭这个窗口就停止）'); });
