# 插件系统

插件通过 manifest 自描述：`id`、`version`、`type`、`capabilities`、`permissions`、`configSchema`、兼容 Runtime 版本。Provider、Tool、Skill/MCP、Workflow Node 分开注册。插件安装、启用、禁用和升级由 Desktop Host 管理，Runtime 只消费经过校验的注册结果。

第三方代码默认隔离进程运行；权限最小化，配置和凭据不进入事件 payload。
