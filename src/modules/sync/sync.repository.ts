import pool from '@shared/db/connection'

export interface SyncRecord {
  id:         number | string
  table_name: string
  data:       Record<string, any>
  updated_at: string
}

// Upsert generico por tabela e schema
export async function upsertRecords(
  schemaName: string,
  tableName:  string,
  records:    Record<string, any>[]
): Promise<{ inserted: number; updated: number }> {
  if (!records.length) return { inserted: 0, updated: 0 }

  // Validacao de seguranca: apenas letras, numeros e underscores
  if (!/^[a-z0-9_]+$/i.test(tableName)) {
    throw new Error(`Nome de tabela invalido: ${tableName}`)
  }

  const conn = await pool.getConnection()
  let inserted = 0
  let updated  = 0

  try {
    await conn.query(`USE \`${schemaName}\``)

    for (const record of records) {
      const columns = Object.keys(record)
      const values  = Object.values(record)
      const placeholders = columns.map(() => '?').join(', ')
      const updateSet    = columns
        .filter(c => c !== 'id')
        .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(', ')

      const sql = `
        INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${updateSet}
      `

      const [result] = await conn.query<any>(sql, values)
      if (result.affectedRows === 1) inserted++
      if (result.affectedRows === 2) updated++
    }
  } finally {
    conn.release()
  }

  return { inserted, updated }
}

// Busca registros atualizados apos um timestamp
export async function getUpdatedRecords(
  schemaName: string,
  tableName:  string,
  since:      string,
  limit = 500
): Promise<Record<string, any>[]> {
  if (!/^[a-z0-9_]+$/i.test(tableName)) {
    throw new Error(`Nome de tabela invalido: ${tableName}`)
  }

  const conn = await pool.getConnection()
  try {
    await conn.query(`USE \`${schemaName}\``)
    const [rows] = await conn.query<any[]>(
      `SELECT * FROM \`${tableName}\`
       WHERE updated_at > ?
       ORDER BY updated_at ASC
       LIMIT ?`,
      [since, limit]
    )
    return rows
  } finally {
    conn.release()
  }
}

// Registra o log de sync no banco central
export async function writeSyncLog(entry: {
  establishmentCode: string
  schemaName:        string
  direction:         'push' | 'pull'
  tableName:         string
  recordsCount:      number
  status:            'success' | 'error'
  errorMessage?:     string
  durationMs?:       number
}): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.sync_log
      (establishment_code, schema_name, direction, table_name,
       records_count, status, error_message, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.establishmentCode,
      entry.schemaName,
      entry.direction,
      entry.tableName,
      entry.recordsCount,
      entry.status,
      entry.errorMessage ?? null,
      entry.durationMs   ?? null,
    ]
  )
}
