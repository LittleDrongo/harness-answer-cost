/**
 * Rouble rates pinned to account top-ups.
 *
 * The plugin prices every request in roubles with the rate that was in force
 * when the balance was last topped up: on each detected top-up it records the
 * CBR rate of that day as a new period, and only requests after it use the new
 * rate. The CBR series is fetched online; the period log is cached on disk so a
 * restart keeps both the pinned rates and the last seen wallet balance.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** CBR daily series of the USD rate (VAL_NM_RQ=R01235). */
const SERIES_URL = 'https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1={from}&date_req2={to}&VAL_NM_RQ=R01235'
/** Cache file layout version: the rate book, not the earlier day map. */
const CACHE_VERSION = 2
/** Most recent CBR days kept in the cache. */
const MAX_DAYS = 400
/** Days requested from the CBR series on a refresh. */
const REFRESH_DAYS = 30
/** Network deadline for one refresh, in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000

/** Local calendar day of an epoch instant, as `YYYY-MM-DD`. */
export function dayKey(ms) {
  const date = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** `DD/MM/YYYY` for a `YYYY-MM-DD` day. */
function cbrDate(day) {
  const [year, month, date] = day.split('-')
  return `${date}/${month}/${year}`
}

/** Default cache path inside the DSH home. */
export function defaultCacheFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'answer-cost', 'rates.json')
}

/**
 * Parse the CBR dynamic series into `{ 'YYYY-MM-DD': rate }`.
 * The document is windows-1251, but every field used here is ASCII, so a UTF-8
 * decode keeps the numbers and dates intact.
 * @param text - response body of `XML_dynamic.asp`.
 * @returns the parsed days; malformed records are skipped.
 */
export function parseSeries(text) {
  const rates = {}
  if (typeof text !== 'string') return rates
  const record = /<Record Date="(\d{2})\.(\d{2})\.(\d{4})"[^>]*>([\s\S]*?)<\/Record>/g
  let match
  while ((match = record.exec(text)) !== null) {
    const [, date, month, year, body] = match
    const nominal = /<Nominal>(\d+)<\/Nominal>/.exec(body)
    const value = /<Value>([\d.,]+)<\/Value>/.exec(body)
    if (nominal === null || value === null) continue
    const units = Number(nominal[1])
    const amount = Number(value[1].replace(',', '.'))
    if (!Number.isFinite(amount) || !Number.isFinite(units) || units <= 0 || amount <= 0) continue
    rates[`${year}-${month}-${date}`] = amount / units
  }
  return rates
}

/** Keep only the newest `MAX_DAYS` days. */
function pruneRates(rates) {
  const keys = Object.keys(rates).sort()
  if (keys.length <= MAX_DAYS) return rates
  const kept = {}
  for (const key of keys.slice(keys.length - MAX_DAYS)) kept[key] = rates[key]
  return kept
}

/** A valid rate period, or undefined. */
function parsePeriod(value) {
  if (value === null || typeof value !== 'object') return undefined
  const at = value.at
  const rate = value.rate
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
  return { at, rate }
}

/** Daily CBR rates plus the top-up period log. */
export class RateBook {
  /** @param options - cache file, optional logger and fetch implementation. */
  constructor({ file, log, fetchImpl } = {}) {
    this.file = typeof file === 'string' && file.length > 0 ? file : defaultCacheFile()
    this.log = log
    this.fetch = fetchImpl ?? globalThis.fetch
    /** @type {Record<string, number>} */
    this.days = {}
    /** @type {{ at: number, rate: number }[]} */
    this.periods = []
    /** @type {{ currency: string, amount: number } | null} */
    this.lastBalance = null
    this.version = 0
    this.lastError = undefined
  }

  /** Load the persisted book; a missing or older file starts empty. */
  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return
      const days = parsed.days
      if (days !== null && typeof days === 'object') {
        const accepted = {}
        for (const key of Object.keys(days)) {
          const value = days[key]
          if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof value === 'number' && Number.isFinite(value) && value > 0) accepted[key] = value
        }
        this.days = pruneRates(accepted)
      }
      if (Array.isArray(parsed.periods)) {
        this.periods = parsed.periods.map(parsePeriod).filter(period => period !== undefined).sort((left, right) => left.at - right.at)
      }
      const balance = parsed.lastBalance
      if (balance !== null && typeof balance === 'object'
        && typeof balance.currency === 'string'
        && typeof balance.amount === 'number' && Number.isFinite(balance.amount)) {
        this.lastBalance = { currency: balance.currency, amount: balance.amount }
      }
      this.version += 1
    } catch {
      // A missing cache is the normal first run.
    }
  }

  /** Write the book atomically enough for a cache: write then rename. */
  async persist() {
    const payload = JSON.stringify({
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      days: this.days,
      periods: this.periods,
      lastBalance: this.lastBalance,
    }, null, 2)
    try {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, payload, 'utf8')
      await fs.rename(temporary, this.file)
    } catch (error) {
      this.lastError = error
      if (this.log !== undefined) this.log.warn(`answer-cost: cannot cache rates at ${this.file}`)
    }
  }

  /** Fetch the recent CBR series and merge it; stored days are never rewritten. */
  async refresh(days = REFRESH_DAYS) {
    if (typeof this.fetch !== 'function') return false
    const now = Date.now()
    const from = dayKey(now - Math.max(1, days) * 24 * 60 * 60 * 1000)
    const url = SERIES_URL.replace('{from}', cbrDate(from)).replace('{to}', cbrDate(dayKey(now)))
    let response
    try {
      response = await this.fetch(url, {
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
          : undefined,
        headers: { accept: 'application/xml,text/xml,*/*' },
      })
    } catch (error) {
      this.lastError = error
      if (this.log !== undefined) this.log.warn('answer-cost: CBR rate request failed')
      return false
    }
    if (response === null || response === undefined || response.ok !== true) {
      this.lastError = new Error(`CBR responded ${response === undefined ? 'nothing' : String(response.status)}`)
      return false
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      this.lastError = error
      return false
    }
    const fetched = parseSeries(text)
    const fetchedDays = Object.keys(fetched)
    if (fetchedDays.length === 0) return false
    let changed = false
    for (const day of fetchedDays) {
      if (this.days[day] === undefined) {
        this.days[day] = fetched[day]
        changed = true
      }
    }
    if (changed) {
      this.days = pruneRates(this.days)
      this.version += 1
      await this.persist()
    }
    return changed
  }

  /**
   * CBR rate for one local day, falling back to the nearest earlier day.
   * @param day - `YYYY-MM-DD`.
   * @returns the rate, or undefined when no day is cached at all.
   */
  rateOnDay(day) {
    if (typeof day === 'string' && typeof this.days[day] === 'number') return this.days[day]
    const keys = Object.keys(this.days).sort()
    if (keys.length === 0) return undefined
    let earlier
    for (const key of keys) {
      if (typeof day === 'string' && key < day) earlier = key
    }
    return this.days[earlier ?? keys[0]]
  }

  /**
   * Pin the rate of one top-up: the CBR rate of its day, else the nearest
   * earlier published day, else the packaged fallback.
   * @param at - top-up detection instant, epoch milliseconds.
   * @param fallback - packaged rate used when no online rate is known.
   * @returns the recorded period.
   */
  async recordTopUp(at, fallback) {
    const online = this.rateOnDay(dayKey(at))
    const rate = typeof online === 'number' && Number.isFinite(online) && online > 0
      ? online
      : fallback
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
    const period = { at, rate }
    this.periods.push(period)
    this.periods.sort((left, right) => left.at - right.at)
    this.version += 1
    await this.persist()
    return period
  }

  /** Period in force at one instant, or undefined before the first top-up. */
  periodAt(time) {
    let found
    for (const period of this.periods) {
      if (period.at <= time) found = period
      else break
    }
    return found
  }

  /** Detached period list for the Client view. */
  snapshotPeriods() {
    return this.periods.map(period => ({ at: period.at, rate: period.rate }))
  }
}
