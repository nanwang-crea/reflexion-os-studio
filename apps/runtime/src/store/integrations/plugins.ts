import type { DatabaseSync } from 'node:sqlite'
import {
  PluginPackageManifestSchema,
  SemVerSchema,
  type PluginPackageManifest,
  type PluginRecord,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

export interface PluginUpsertInput {
  id: string
  kind: PluginRecord['kind']
  version: string
  name: string
  description: string
  source: PluginRecord['source']
  sourceRef: string | null
  scope: PluginRecord['scope']
  projectId: string | null
  status: PluginRecord['status']
  installPath: string | null
  enabled: boolean
  manifest: PluginPackageManifest
  error: string | null
}

export class PluginStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): PluginRecord[] {
    return this.db
      .prepare('SELECT * FROM plugins ORDER BY name COLLATE NOCASE, id')
      .all()
      .map((row) => this.toRecord(row as Row))
  }

  get(id: string): PluginRecord | null {
    const row = this.db.prepare('SELECT * FROM plugins WHERE id = ?').get(id)
    return row ? this.toRecord(row as Row) : null
  }

  upsert(input: PluginUpsertInput): PluginRecord {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO plugins
          (id, kind, version, name, description, source, source_ref, scope, project_id, status,
           install_path, enabled, compat_json, manifest_json, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           version = excluded.version,
           name = excluded.name,
           description = excluded.description,
           source = excluded.source,
           source_ref = excluded.source_ref,
           scope = excluded.scope,
           project_id = excluded.project_id,
           status = excluded.status,
           install_path = excluded.install_path,
           enabled = excluded.enabled,
           compat_json = excluded.compat_json,
           manifest_json = excluded.manifest_json,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.kind,
        input.version,
        input.name,
        input.description,
        input.source,
        input.sourceRef,
        input.scope,
        input.projectId,
        input.status,
        input.installPath,
        input.enabled ? 1 : 0,
        JSON.stringify(input.manifest.compatibility),
        JSON.stringify(input.manifest),
        input.error,
        now,
        now,
      )
    const record = this.get(input.id)
    if (!record) throw new Error(`plugin not found after upsert: ${input.id}`)
    return record
  }

  setEnabled(id: string, enabled: boolean): PluginRecord | null {
    this.db
      .prepare(
        `UPDATE plugins SET enabled = ?, status = ?, error = NULL, updated_at = ?
         WHERE id = ? AND status <> 'invalid'`,
      )
      .run(enabled ? 1 : 0, enabled ? 'enabled' : 'disabled', nowIso(), id)
    return this.get(id)
  }

  remove(id: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id).changes,
      ) > 0
    )
  }

  private toRecord(row: Row): PluginRecord {
    const storedManifest = PluginPackageManifestSchema.safeParse(
      JSON.parse(String(row.manifest_json)),
    )
    const legacyCompat =
      row.compat_json == null
        ? { protocol: '^1.3' }
        : (JSON.parse(String(row.compat_json)) as { protocol: string })
    const manifest = storedManifest.success
      ? storedManifest.data
      : PluginPackageManifestSchema.parse({
          manifestVersion: 1,
          id: String(row.id),
          name: String(row.name),
          version: normalizeLegacyVersion(String(row.version)),
          description: String(row.description),
          type: String(row.kind),
          entry: 'SKILL.md',
          compatibility: legacyCompat,
          capabilities: ['skill.instructions'],
          permissions: {
            filesystem: 'none',
            network: false,
            shell: false,
          },
          skill: { tools: [], argumentHint: null },
        })
    return {
      id: String(row.id),
      kind: String(row.kind) as PluginRecord['kind'],
      version: String(row.version),
      name: String(row.name),
      description: String(row.description),
      source: String(row.source) as PluginRecord['source'],
      sourceRef: row.source_ref == null ? null : String(row.source_ref),
      scope: (row.scope == null
        ? 'global'
        : String(row.scope)) as PluginRecord['scope'],
      projectId: row.project_id == null ? null : String(row.project_id),
      status: String(row.status) as PluginRecord['status'],
      installPath: row.install_path == null ? null : String(row.install_path),
      enabled: Number(row.enabled) === 1,
      manifest,
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

function normalizeLegacyVersion(version: string): string {
  return SemVerSchema.safeParse(version).success ? version : '0.0.0'
}
