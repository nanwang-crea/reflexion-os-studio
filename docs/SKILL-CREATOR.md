# Skill 创建与脚本资源

内置 skill-creator 参考 Codex 内置技能的精炼说明、渐进披露、按需资源、实际验证和保留用户意图原则，适配本产品工具与作用范围。

Skill 可包含 scripts、references、assets。执行按任务需要进行，不在安装或 skill.use 时自动运行。skill.prepare 将已启用且当前项目可见的包复制到 Runtime 专属临时快照，提供文件清单、资源内容和实际 Node 路径。脚本通过原有 shell.execute 执行；沿用会话权限、沙箱、网络审批、超时、输出和取消机制，不增加 Skill 专用脚本审批。

resource 从资源清单中按需分页读取 UTF-8 文本。可选 offset 为 UTF-8 字节偏移（默认 0），limit 为每页字节上限（默认 100000，范围 4–100000）；不指定 resource 时不能传分页参数。小文件默认返回全文，大文件自动返回第一页；resource 结果保留 path/content，并增加 offset、bytesRead、totalBytes、hasMore、nextOffset。hasMore 为 true 时，将 nextOffset 原样作为下次 offset；末页 nextOffset 为 null。分页不会截断 UTF-8 字符，实际 bytesRead 可能小于 limit；工具还会按模型回填预算缩小页并同步续读游标，防止通用截断省略正文导致丢页。读取页时模型正文仅含 skillId、version 和 resource，避免重复快照元数据；目录、解释器和完整清单仍可通过不带 resource 的调用获取，结构化 data 保留这些字段。偏移必须位于字符边界，等于文件大小返回空末页，超出大小返回明确错误。空文件返回空正文且 hasMore 为 false。换行（含 CRLF）原样保留，不按行拆页。

快照保留所有资源的文件大小与摘要；建立摘要、复核摘要和校验 UTF-8 均使用固定大小缓冲区，正文缓存仅保留有限页，缓存淘汰不影响续读。每次未命中缓存的读取会扫描并校验完整文件（IO 随文件大小增长，内存与输出按页有界），复核路径、普通文件身份与原始内容，避免脚本替换快照后借此读取其他文件。二进制、编码无效、路径无效、分页参数无效和快照变化等错误以带具体原因的工具错误返回；取消继续向上传递。技能包总大小和文件数仍受既有包校验上限约束。

快照在数据目录之外，允许沙箱读取代码而不开放应用数据库和凭据。按 Run 隔离，结束时清理，最多同时保留 32 个包。三个平台使用 node:path、os.tmpdir 和现有 Rust Shell provider；Python 等外部解释器是否安装须验证，Node 使用随 Runtime 提供的实际可执行文件。Windows/Linux 原生沙箱的既有验收限制不改变。

skill.save 是主 Agent 的持久化工具：当前项目或全局，保存前展示完整配置并走单次审批。支持标准 SKILL.md 及有限的文本资源，复用包校验与原子安装。更新必须指定 expectedVersion、保持作用范围且不能修改内置技能；旧资源保持，明确提供的同路径资源替换，版本递增。不是任意文件读取或脚本执行入口。

所有执行仍遵守敏感数据禁读禁传；包的工具声明不是授权。第三方脚本的按需执行属于本次明确授权，替代旧的“第三方 Skill 仅声明式”限制。脚本不会在 Runtime 主进程中 import/eval。

全局包：`<数据目录>/skills/<id>/`（默认 `~/.reflexion-os-studio/skills/`）；项目包：`<项目>/.reflexion-os-studio/skills/<id>/`。每个 Skill 保存完整文件包，不经过 Asset Store。启动/重新扫描会发现项目目录中的标准包；旧 plugins 安装迁移时保留原目录，不覆盖现有目标。当前技能 ID 仍在应用中唯一，跨项目复用请选择全局范围。

内置技能也会导出完整 SKILL.md 包到全局目录，供查看与 skill.prepare 读取；应用只刷新标记为自身管理的内置包，不覆盖同名用户目录。内置技能升级随应用版本提供；通过 skill.save 保存的新技能与更新仍走正式审批。

普通 Skill 目录只需 SKILL.md 及可选资源；安装器不补写 plugin.json。skill.save 将标准包版本写入 SKILL.md 的 metadata.version，更新保留其他 frontmatter 字段。显式提供的旧扩展 manifest 继续兼容。内置包管理记录位于数据目录 builtin-skills/，旧内置包的受管标记会迁移到该内部目录。
