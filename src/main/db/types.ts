type ColumnDef =
  | string
  | { type: string; notNull?: boolean; default?: string; check?: string; primaryKey?: boolean }
type IndexDef = string[] | { columns: string[]; where?: string; unique?: boolean }
interface TableDef {
  columns: Record<string, ColumnDef>
  foreignKeys?: Array<{ columns: string[]; ref: string; onDelete?: string }>
  indexes?: Record<string, IndexDef>
  dropColumns?: string[]
  normalizeOnRebuild?: Record<string, string>
}
type SchemaDef = Record<string, TableDef>

export type { ColumnDef, IndexDef, TableDef, SchemaDef }
