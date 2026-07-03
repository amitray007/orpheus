import type { ColumnDef, IndexDef, TableDef } from './types'

function enumClause(col: string, values: readonly string[]): string {
  return `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`
}

function enumCheck(col: string, values: readonly string[]): string {
  return `CHECK (${enumClause(col, values)})`
}

function renderColumn(colName: string, def: ColumnDef): string {
  if (typeof def === 'string') {
    return `${colName} ${def}`
  }
  let out = `${colName} ${def.type}`
  if (def.primaryKey) out += ' PRIMARY KEY'
  if (def.notNull) out += ' NOT NULL'
  if (def.default !== undefined) out += ` DEFAULT ${def.default}`
  if (def.check) out += ` ${def.check}`
  return out
}

function renderCreateTable(name: string, def: TableDef): string {
  const columnLines = Object.entries(def.columns).map(([colName, colDef]) =>
    renderColumn(colName, colDef)
  )
  const foreignKeyLines = (def.foreignKeys ?? []).map(
    (fk) =>
      `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.ref}${fk.onDelete ? ' ON DELETE ' + fk.onDelete : ''}`
  )
  const lines = [...columnLines, ...foreignKeyLines]
  return `CREATE TABLE ${name} (\n  ${lines.join(',\n  ')}\n)`
}

function renderIndex(table: string, name: string, def: IndexDef): string {
  const columns = Array.isArray(def) ? def : def.columns
  const unique = !Array.isArray(def) && def.unique
  const where = !Array.isArray(def) ? def.where : undefined
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table}(${columns.join(', ')})${where ? ' WHERE ' + where : ''}`
}

export { enumCheck, enumClause, renderColumn, renderCreateTable, renderIndex }
