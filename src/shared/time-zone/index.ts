/**
 * FUSO DO ESTABELECIMENTO no setes-sync (D-TZ4: a mesma regra do setes-api, D-TZ1).
 * Cópia consciente e enxuta de setes-api `src/shared/time-zone/index.ts` (D13 do prompt
 * da revisão: sem dependência entre os projetos) — só o que o sync usa:
 *  - `institutionZoneFor`: a zona IANA configurada (interface 'establishment', config
 *    `time_zone`; ausente/inválida = America/Sao_Paulo). Dentro de transação, a leitura
 *    vai pela CONEXÃO dela (C1 do gate da API: nunca uma 2ª conexão do pool).
 *  - `toUtcDb`: hora de parede do legado (sem offset) ou com offset → instante UTC.
 * Conversões por Intl (ICU do Node) — nenhuma lib nova.
 */

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'

/** Qualquer coisa que execute SQL: o pool ou a conexão da transação em curso. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<any>
}

/** Zona IANA válida para o Intl? (config corrompida nunca derruba a gravação) */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const ZONE_TTL_MS = Number(process.env.TIME_ZONE_CACHE_TTL_MS ?? 60_000)
const zoneCache = new Map<string, { zone: string; expires: number }>()

/** Esquece a zona em cache (testes; em produção vale o TTL). */
export function invalidateInstitutionZone(): void {
  zoneCache.clear()
}

/** Zona do estabelecimento. Uma consulta (catálogo + valor da institution), não travante, cache por TTL. */
export async function institutionZoneFor(
  schemaName: string, institutionId: number, q: Queryable
): Promise<string> {
  const key = `${schemaName}|${institutionId}`
  const hit = zoneCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.zone
  if (!/^[A-Za-z0-9_]+$/.test(schemaName)) return DEFAULT_TIME_ZONE
  const [rows] = await q.query(
    `SELECT COALESCE(v.content, c.default_content) AS zone
       FROM setes_central.tb_interface i
       JOIN setes_central.tb_interface_has_config c
         ON c.tb_interface_id = i.id AND c.name = 'time_zone' AND c.deleted = 'N'
       LEFT JOIN \`${schemaName}\`.tb_institution_has_config v
         ON v.tb_interface_id = i.id AND v.name = 'time_zone' AND v.tb_institution_id = ?
        AND v.tb_user_id = 0 AND v.deleted = 'N'
      WHERE i.i18n_key = 'establishment' AND i.deleted = 'N'
      LIMIT 1`,
    [institutionId]
  )
  const raw = (rows as any[])?.[0]?.zone
  const zone = typeof raw === 'string' && raw !== '' && isValidTimeZone(raw) ? raw : DEFAULT_TIME_ZONE
  zoneCache.set(key, { zone, expires: Date.now() + ZONE_TTL_MS })
  return zone
}

/** Offset (ms) da zona no instante [utcMs]: horaLocal − horaUTC. */
function offsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/**
 * Data/hora → instante UTC para gravar ('YYYY-MM-DD HH:MM:SS'). Com offset ('Z',
 * '-03:00') vale o offset; SEM offset a hora é lida como parede de [zone] (é como o
 * Delphi manda). Data/hora impossível = null.
 */
export function toUtcDb(value: string | null | undefined, zone: string = DEFAULT_TIME_ZONE): string | null {
  if (!value) return null
  const v = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m
  const daysIn = new Date(Date.UTC(+y, +mo, 0)).getUTCDate()
  if (+y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || +d > daysIn) return null
  if (+mi > 59 || +se > 59 || +h > 24 || (+h === 24 && (+mi > 0 || +se > 0))) return null
  if (tz && tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '')
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59) return null
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)
  let utc: number
  if (tz) {
    const sign = tz === 'Z' ? 0 : tz[0] === '-' ? -1 : 1
    const digits = tz === 'Z' ? '0000' : tz.slice(1).replace(':', '')
    utc = wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
  } else {
    utc = wall - offsetMs(zone, wall)
    utc = wall - offsetMs(zone, utc)
  }
  const dt = new Date(utc)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
}
