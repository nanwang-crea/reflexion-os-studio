import { randomUUID } from 'node:crypto'
import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import { argsRecord, optionalNumber, requireString } from './shared.js'

const CHUNK = 12_000
const MAX_CHUNK = 50_000
type Stream = 'stdout' | 'stderr'

export class ShellOutputStore {
  private readonly entries = new Map<string, Record<Stream, string>>()

  capture(result: ToolResult): ToolResult {
    if (result.isError) return result
    try {
      const data = JSON.parse(result.content) as Record<string, unknown>
      const stdout = typeof data.stdout === 'string' ? data.stdout : ''
      const stderr = typeof data.stderr === 'string' ? data.stderr : ''
      const outputId = randomUUID()
      this.entries.set(outputId, { stdout, stderr })
      while (this.entries.size > 16)
        this.entries.delete(this.entries.keys().next().value!)
      Object.assign(data, {
        outputId,
        stdout: stdout.slice(0, CHUNK),
        stderr: stderr.slice(0, CHUNK),
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        stdoutTruncated: stdout.length > CHUNK || data.truncated === true,
        stderrTruncated: stderr.length > CHUNK || data.truncated === true,
      })
      return { ...result, content: JSON.stringify(data), data: data as never }
    } catch {
      return result
    }
  }

  read(
    id: string,
    stream: Stream,
    offset: number,
    limit: number,
  ): Record<string, unknown> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('shell output expired or not found')
    const source = entry[stream]
    const content = source.slice(offset, offset + limit)
    const nextOffset = offset + content.length
    return {
      outputId: id,
      stream,
      offset,
      content,
      truncated: nextOffset < source.length,
      ...(nextOffset < source.length ? { nextOffset } : {}),
    }
  }
}

export function createShellOutputReadTool(
  store: ShellOutputStore,
): ToolDefinition {
  return {
    name: 'shell.output.read',
    description:
      '使用 shell.execute 返回的 outputId 分段续读 stdout 或 stderr。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outputId: { type: 'string', minLength: 1 },
        stream: { type: 'string', enum: ['stdout', 'stderr'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_CHUNK },
      },
      required: ['outputId', 'stream'],
    },
    execute: ({ args }) => {
      const record = argsRecord(args)
      if (record.stream !== 'stdout' && record.stream !== 'stderr')
        throw new Error('invalid stream')
      const data = store.read(
        requireString(args, 'outputId'),
        record.stream,
        Math.max(0, Math.trunc(optionalNumber(args, 'offset') ?? 0)),
        Math.min(
          MAX_CHUNK,
          Math.max(1, Math.trunc(optionalNumber(args, 'limit') ?? CHUNK)),
        ),
      )
      return {
        content: JSON.stringify(data),
        data: data as never,
        isError: false,
      }
    },
  }
}
