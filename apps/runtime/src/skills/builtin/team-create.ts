import type { SkillDefinition } from '../types.js'

export const TEAM_CREATE_SKILL: SkillDefinition = {
  manifest: {
    id: 'team-create',
    name: '创建协作团队',
    version: '1.0.1',
    description:
      '根据目标设计团队职责、交接和验收要求，复用可见角色或经审批批量保存新角色；使用内置 Runtime 工具直接落地到 Agent 配置。',
    tools: ['agent_team.inspect', 'agent_team.create', 'ask_user'],
    argumentHint: '<团队用途与目标>',
    whenToUse:
      '用户希望创建、预设或保存开发、写作、调研等可复用 Agent 团队时。',
    license: null,
    metadata: {},
  },
  instructions: `
# 创建团队

## 查询真实配置
先调用 agent_team.inspect。角色保存在应用数据库中，不要搜索工作区寻找角色模板文件，不要猜测模型或模板 ID。查询返回当前项目可见团队、完整角色指令、工具权限、模型能力和实际工作区。
若已有团队满足目标，复用并给出真实 templateId；只需临时分工时用动态 task，不强制保存团队。需要现有素材或项目约定时，只读取与产物有关的文件。

## 设计最小完整团队
从目标判断角色数量，不机械凑齐所有岗位。写作通常采用策划/研究、撰稿、独立编辑；开发通常采用调研/设计、实现、独立审阅。主 Agent 负责调度、整合、解决交接冲突和最终交付。
为每个角色写出：职责及不负责事项、必需输入、交付物、交接对象与依赖、可验证的完成标准、发现问题时的返工要求。上述约定写入该角色 systemPrompt，不只写一句头衔。
研究角色交付来源与事实/推断区分；撰稿角色交付结构完整的稿件与来源引用；编辑角色报告定位明确的事实、结构和表达问题，并提出可操作修改；实现角色交付变更与验证证据；独立审阅角色不自行修改成果。

## 配置能力
默认项目范围；无项目时全局。用户明确要求跨项目复用时选择全局。teamId 使用短英文标识，domains 只填开发/写作等领域，工具会添加 team:<teamId> 成员标识。
用户未指定模型时用 modelBinding={"mode":"inherit"}，不要擅自选择昂贵模型；指定模型时依据 inspect 的 providerId/model 和支持的思考选项设置 fixed，不可用先说明缺失配置。
只读研究/审阅角色使用 file.read/list/glob/grep、skill.use；公开网络调研角色需要 browser.navigate、browser.read、browser.close，加载 web-research 用搜索结果找真实链接。web.fetch 可保留用于已知 URL 的轻量读取，不能替代搜索；没有启用浏览器时说明限制。需要形成文件的作者/实现角色增加 file.write、file.edit、file.mkdir，按需要加入 file.write_stream。Shell、删除和继续委派只在目标确需时配置；canDelegate=true 必须包含 task。默认 permissionCeiling=workspace-read，实际写入仍需审批；用户需要更宽上限时明确说明。模板不能扩张父 Run 的权限。

## 保存与交付
先在对话给出简明角色配置和交接方案，再调用 agent_team.create，传入 teamId、scope、roles。工具走正式审批；不要为同一保存再增加 ask_user 确认。用户拒绝后不重试绕过。只有工具成功才声明角色已保存；批量保存失败不会留下部分角色。
同范围同团队标识已经存在时使用现有角色，需编辑模型/权限等可在 Agent 页进行；不要以改名反复创建重复团队，不覆盖或删除旧配置。
成功后列出团队、实际角色 ID、职责、模型继承/预设、工具上限和下一步使用方法：$agent-collaboration 加目标。团队配置在 Agent 页管理，不额外生成假配置文件。
产物保存目录遵循用户和已有项目约定；没有约定则选择与任务有关的相对路径并告知用户，不为建立团队遍历整个项目，也不在创建角色时生成空稿件。
`.trim(),
}
