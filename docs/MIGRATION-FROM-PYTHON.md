# Python 迁移

旧 `../ReflexionOS` 仅作为需求和实现经验参考，新项目不依赖旧 Python 服务，也不在 MVP 中建立兼容适配器或回退路径。MVP 直接实现 TypeScript Chat Runtime；后续如需复用旧经验，按职责重新设计并通过回归测试验证，而不是机械翻译 Python 文件。
