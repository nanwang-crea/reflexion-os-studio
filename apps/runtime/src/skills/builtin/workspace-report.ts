import type { SkillDefinition } from '../types.js'

/** 工作区盘点：摸清目录结构与文件构成，产出结构化清单报告。 */
export const WORKSPACE_REPORT_SKILL: SkillDefinition = {
  manifest: {
    id: 'workspace-report',
    name: '工作区盘点',
    version: '1.0.0',
    description:
      '盘点当前工作区：目录结构、文件类型分布、大文件与异常文件（如临时/锁文件），产出一份结构化报告，可按需写入文件。',
    tools: ['file.list', 'file.glob', 'file.grep', 'file.write'],
    argumentHint: '[输出报告的路径] [关注点]',
  },
  instructions: `
# 工作区盘点

对当前工作区做一次结构化盘点并输出报告。

## 步骤

1. **结构**：用 file.list（recursive=true）拿到全量文件清单；
   条目被截断（truncated）时改用 file.glob 分类型补齐。
2. **构成分析**：按扩展名分组统计数量与总大小；标出最大的几个文件。
3. **异常项**：留意临时/锁文件（如 ~$ 开头的 Office 锁文件）、重复内容文件、意外的大二进制。
4. **关注点**：用户指定了关注点（如"找出所有成本表"）时，围绕它用 file.glob/file.grep 深入。

## 输出格式

- 目录结构：精简树（超过 3 层用 … 折叠）
- 文件构成：Markdown 表格（类型、数量、合计大小）
- 异常与建议：逐条列出，无则写"未发现异常"
- 用户要求写入文件时用 file.write，否则直接在回复中输出全文
`.trim(),
}
