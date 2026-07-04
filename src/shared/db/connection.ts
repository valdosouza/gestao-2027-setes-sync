import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
})

export async function getConnection(schemaName: string) {
  const conn = await pool.getConnection()
  await conn.query(`USE \`${schemaName}\``)
  return conn
}

export default pool
