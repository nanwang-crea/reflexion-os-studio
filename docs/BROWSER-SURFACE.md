# Browser Surface

Browser Surface 是桌面 Agent 内的受控网页查看区域，不是 Chat Core 的依赖。

## Phase 1A

不启动内嵌浏览器。外部 URL 仅通过安全协议白名单交给系统浏览器，失败显示可恢复错误。

## Phase 1B

可选实现只读内嵌 Surface：仅支持 https URL 的打开和有限导航，失败统一回退系统浏览器。页面与应用 UI、Runtime、文件系统隔离，不允许脚本、下载、剪贴板、持久化登录或宿主 API 访问。Renderer 发送结构化 Command，Desktop Host 管理隔离 WebContents 生命周期，所有导航可审计。

## Phase 2

再加入页面快照、内容提取、搜索、Browser Tool 自动化、多标签和受控登录资料，并进行独立安全评审。
