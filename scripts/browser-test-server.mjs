#!/usr/bin/env node
// Deterministic local website for manual Browser Surface acceptance; not product IPC.
import { createServer } from 'node:http'

const port = Number(process.env.BROWSER_TEST_PORT ?? 47630)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid BROWSER_TEST_PORT')

let cacheMarker = 0

const page = (second = false) => `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Browser acceptance fixture</title>
<style>body{font:16px system-ui;padding:24px;color:#17202a;background:#f7f9fb}button,a,input{margin:8px;padding:8px}output{display:block;margin:16px}</style>
<h1>${second ? '第二页' : 'Browser Surface 验收页'}</h1>
<p id="scripts">JavaScript 未运行</p><p id="bridge"></p><p id="storage"></p>
<a href="/second">进入第二页</a><a href="/" target="_blank">新窗口请求</a><a href="/redirect">重定向</a>
<a href="/download" download>下载测试</a><a href="/attachment">附件响应测试</a>
<button id="remember">写入临时测试 Cookie</button>
<button id="persist">写入持久测试标记</button>
<a href="/slow-download">慢速下载</a><a href="/download-redirect">同来源下载重定向</a><a href="/cross-download">跨来源下载重定向</a>
<p id="persistent"></p><button id="cache">读取缓存测试标记</button><p id="cached"></p>
<button id="file">尝试 file 协议</button><button id="media">请求摄像头和麦克风</button>
<label>上传测试<input type="file"></label><output id="result"></output>
<script>
const result = document.querySelector('#result');
document.querySelector('#scripts').textContent = 'JavaScript 正常运行';
document.querySelector('#bridge').textContent = 'Host IPC: ' + (window.__TAURI_INTERNALS__ || window.__TAURI__ ? '发现桥（失败）' : '无桥（通过）');
document.querySelector('#storage').textContent = '临时测试 Cookie: ' + (document.cookie.includes('browser_spike_marker=1') ? '存在' : '不存在');
document.querySelector('#remember').onclick = () => { document.cookie='browser_spike_marker=1; SameSite=Strict; path=/'; location.reload(); };
document.querySelector('#persistent').textContent = '持久测试标记: ' + (document.cookie.includes('browser_persistent_marker=1') && localStorage.getItem('browser_persistent_marker') === '1' ? '存在' : '不存在');
document.querySelector('#persist').onclick = () => { document.cookie='browser_persistent_marker=1; Max-Age=86400; SameSite=Strict; path=/'; localStorage.setItem('browser_persistent_marker', '1'); location.reload(); };
document.querySelector('#cache').onclick = async () => { document.querySelector('#cached').textContent = '缓存测试标记: ' + await (await fetch('/cache-marker', {cache:'force-cache'})).text(); };
document.querySelector('#file').onclick = () => { location.href='file:///tmp/browser-test-never-read'; };
document.querySelector('#media').onclick = async () => { try { const stream = await navigator.mediaDevices.getUserMedia({audio:true,video:true}); stream.getTracks().forEach(track=>track.stop()); result.textContent='媒体权限意外允许（失败）'; } catch (error) { result.textContent='媒体权限拒绝: ' + error.name; } };
</script></html>`

const server = createServer((request, response) => {
  if (request.url === '/cache-marker') {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=86400',
    })
    response.end(`synthetic-cache-${++cacheMarker}`)
    return
  }
  if (
    request.url === '/download-redirect' ||
    request.url === '/cross-download'
  ) {
    response.writeHead(302, {
      Location:
        request.url === '/cross-download'
          ? `http://localhost:${port}/attachment`
          : '/attachment',
    })
    response.end()
    return
  }
  if (request.url === '/slow-download') {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="browser-slow-fixture.txt"',
      'Content-Length': 1024 * 120,
    })
    let remaining = 120
    const timer = setInterval(() => {
      response.write(Buffer.alloc(1024, 65))
      if (--remaining === 0) {
        clearInterval(timer)
        response.end()
      }
    }, 2500)
    response.on('close', () => clearInterval(timer))
    return
  }
  if (request.url === '/download' || request.url === '/attachment') {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="browser-test.txt"',
    })
    response.end('Synthetic Browser acceptance fixture. No user data.')
    return
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/second' })
    response.end()
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(page(request.url === '/second'))
})
server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`Browser fixture: http://127.0.0.1:${port}\n`)
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close())
