import { chromium } from 'playwright'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

const executable = chromium.executablePath()
await access(
  executable,
  process.platform === 'win32' ? constants.F_OK : constants.X_OK,
)
process.stdout.write(JSON.stringify({ executable }) + '\n')
