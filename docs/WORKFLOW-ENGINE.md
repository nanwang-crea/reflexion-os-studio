# Workflow Engine

Workflow 是版本化 DAG：节点、端口、边和配置均有 schema。提交前做类型兼容、环检测和权限校验。Runner 使用拓扑调度，独立分支可并行；每个 NodeRun 产生 started/progress/completed/failed 事件并写 checkpoint。支持条件、循环、人工审批和子工作流，但不把 Provider 细节写进 Graph Engine。
