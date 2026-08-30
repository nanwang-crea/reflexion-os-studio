import type { SkillDefinition } from '../types.js'

/** 网络调研：抓取网页并输出带来源的摘要，明确区分事实与推断。 */
export const WEB_RESEARCH_SKILL: SkillDefinition = {
  manifest: {
    id: 'web-research',
    name: '网络调研',
    version: '1.0.0',
    description:
      '就一个问题抓取相关网页（web.fetch）并综合成带来源链接的调研摘要；不访问需要登录的页面。',
    tools: ['web.fetch'],
    argumentHint: '<调研问题> [起始 URL]',
  },
  instructions: `
# 网络调研

围绕用户的问题做一次轻量网络调研，输出可核实的结论。

## 步骤

1. **拆问题**：把问题拆成 1-3 个可由单个页面回答的子问题。
2. **抓取**：用户给了起始 URL 就先抓它；否则按子问题构造搜索或直接抓取已知权威站点。
   每个子问题最多抓 2-3 个页面；连续失败的来源直接放弃并如实说明。
3. **综合**：只依据抓到的内容回答；页面里没有的信息要标注"未能从公开页面核实"。

## 纪律

- 每条关键结论后附来源链接（Markdown 链接）。
- 不同来源冲突时并列展示，不要擅自裁断。
- 不抓取需要登录/付费的页面；抓取失败不重试超过一次。
- 输出结构：结论（要点列表）→ 依据与来源 → 未解决的问题。
`.trim(),
}
