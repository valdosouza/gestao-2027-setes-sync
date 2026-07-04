import { parse, isValid, format } from 'date-fns'

const FALLBACK = '1900-01-01 01:00:00'
const OUTPUT   = 'yyyy-MM-dd HH:mm:ss'

export function normalizeDate(value: string | null | undefined): string {
  if (!value) return FALLBACK

  // Tenta formato brasileiro DD/MM/YYYY HH:MM:SS
  let d = parse(value, 'dd/MM/yyyy HH:mm:ss', new Date())
  if (isValid(d)) return format(d, OUTPUT)

  // Tenta formato MySQL YYYY-MM-DD HH:MM:SS
  d = parse(value, 'yyyy-MM-dd HH:mm:ss', new Date())
  if (isValid(d)) return format(d, OUTPUT)

  // Tenta só a data DD/MM/YYYY
  d = parse(value, 'dd/MM/yyyy', new Date())
  if (isValid(d)) return format(d, OUTPUT)

  return FALLBACK
}
