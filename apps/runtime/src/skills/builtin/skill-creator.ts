import type { SkillDefinition } from '../types.js'

export const SKILL_CREATOR_SKILL: SkillDefinition = {
  manifest: {
    id: 'skill-creator',
    name: '技能创建器',
    version: '1.0.0',
    description:
      '创建或更新可复用 Skill，编写标准 SKILL.md 与按需脚本、参考资料和模板，并验证实际行为。',
    tools: [
      'skill.use',
      'skill.prepare',
      'skill.save',
      'file.read',
      'shell.execute',
      'ask_user',
    ],
    argumentHint: '<技能用途或待更新技能>',
    whenToUse:
      '用户要求创建、保存或升级技能、复用协作方法时；普通任务不自动转成 Skill，角色配置使用 team-create。',
    license: null,
    metadata: {},
  },
  instructions: `
# 技能创建器

围绕用户希望复用的能力创建最小完整技能。先读相关项目约定、已有技能和必要示例；用途、输入、产物或约束确实不明确时再询问，不把普通任务擅自扩展成技能工程。

## 包与说明
全局包位于应用数据目录的 skills/<id>/（默认 ~/.reflexion-os-studio/skills/）；项目包位于项目/.reflexion-os-studio/skills/<id>/。一个技能一个目录，包含标准 SKILL.md 和需要的 scripts/、references/、assets/；不存入 Asset Store。
name 使用最多 64 字符的小写英文、数字和连字符；description 清楚说明能力与触发情境。说明保持简洁，只写非显而易见的项目知识、执行决策和验收要求。将较长资料放 references 并明确何时读取；assets 放实际模板，scripts 放重复或需要确定性执行的工作。不要创建无用途的空目录、说明文件或固定步骤仪式。

## 创建与更新
调用 skill.save，传 scope=project/global、id、description、instructions；instructions 只写正文，工具生成 frontmatter。可选 resources 为 [{path:"scripts/example.mjs",content:"..."}] 等文本文件。
默认当前项目；无项目或用户要求跨项目复用时全局。保存会展示完整内容并沿用正式审批，不额外重复询问。拒绝后不绕过审批。
更新时先 skill.prepare 读取现有包与 version，理解原有约定和调用者；传 mode=update、expectedVersion，保持 id 和作用范围。未提供的旧资源保留，同路径资源替换；不能覆盖内置 Skill，也不改名创建重复技能来规避更新。二进制资源通过工作区文件工具准备完整包，再使用既有安装入口。

## 脚本执行与验证
脚本按任务需要自动调用，安装和加载说明不执行脚本。先 skill.prepare 获取快照 directory、resources、nodeExecutable，必要时指定 resource 分页读取参考资料或脚本源码；每页默认最多 100000 字节，hasMore=true 时用返回的 nextOffset 作为 offset 继续读取，不把第一页当作完整文件。通过 shell.execute 执行已检查的脚本，正确引用路径、cwd 使用工作区相对路径（通常为 .）；Node 使用返回的 nodeExecutable，其他解释器先验证是否可用。使用跨平台 Node API，避免假定 Bash、POSIX 路径或某个系统预装软件。
脚本执行沿用会话权限、工具上限、沙箱、网络审批、取消和超时；包声明不是授权，不读取凭据、不请求绕过权限。确需网络时使用 requires_network。输出保存到用户指定或项目约定位置，临时包不是交付目录。角色没有 shell.execute 时不能用 Skill 扩张权限。
实际运行脚本的正常输入、代表性的错误输入，检查产物和退出状态；不要用只检查文字存在的测试代替功能验证。没有工作空间或可用解释器时如实说明未验证项，不能宣称成功。只执行相关脚本，不遍历运行包内所有程序。

交付说明真实技能 ID、存储范围、$技能名 的使用方法、资源与验证结果。只在保存工具成功后宣称已内置/保存；随后按用户反馈更新技能，保留原有目标和必要资源。
`.trim(),
}
