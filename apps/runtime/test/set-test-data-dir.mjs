// 测试数据目录隔离：--import 预载模块，在任何测试文件（及其静态 import，
// 会实例化 SecretStore 默认单例）加载前，把 REFLEXION_DATA_DIR 指到临时目录。
// 防止 provider.configure / mcp.add 等写密钥的路径落到真实 ~/.reflexion-os-studio。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.REFLEXION_DATA_DIR = mkdtempSync(
  join(tmpdir(), 'reflexion-test-data-'),
)
