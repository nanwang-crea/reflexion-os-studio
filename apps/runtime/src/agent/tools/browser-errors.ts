/** Tool-facing descriptions contain no raw request URLs or credential values. */
export const browserFailureMessages: Record<string, string> = {
  browser_navigation_timeout:
    '页面加载超时，浏览器已保留。先 browser.read 查看当前页面，再决定是否继续；不要自动重放提交。',
  browser_navigation_blocked:
    '导航被浏览器或应用内部来源边界阻止，浏览器已保留。请读取当前状态核对。',
  browser_network_dns_failed:
    '浏览器无法解析目标域名，页面已保留；请检查系统网络。',
  browser_network_connection_refused:
    '目标服务拒绝连接，页面已保留；请核对地址及服务状态。',
  browser_network_certificate:
    '目标 TLS/证书校验失败，页面已保留；不自动忽略证书错误。',
  browser_navigation_failed:
    '浏览器导航未完成，当前标签已保留。先读取实际页面，不将此结果解释成网站拒绝访问或搜索无结果。',
  browser_page_loading:
    '页面仍在跳转，当前标签已保留。可短暂等待后 browser.read，不必重新导航。',
  browser_page_unavailable:
    '当前标签尚无可读取的 HTTP(S) 页面，浏览器已保留；可继续导航。',
  browser_target_missing:
    '目标控件不存在或已更新。请 browser.read 刷新快照后重新定位，不必重新导航。',
  browser_target_ambiguous:
    '目标匹配多个控件。请读取最新快照并使用唯一的 ref 或精确 role/name。',
  browser_closed: '当前浏览器标签已关闭，请重新导航打开页面。',
}
