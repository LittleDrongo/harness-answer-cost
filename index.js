/**
 * Answer cost — host half.
 *
 * Publishes token usage for two scopes, both grouped by model route and by the
 * rate period that was in force when the request ran, plus the period list:
 *
 * - this Session's own usage (`buckets`);
 * - the whole project (`project`): every Session of the same folder. Sessions
 *   that are not open are read once per app run from the session store, while
 *   open Sessions contribute their live usage instead of the scanned copy.
 *
 * A rate period starts at every detected balance top-up: the CBR rate of that
 * day is pinned and applies to requests after it, while earlier requests keep
 * the previous period. Buckets before the first detected top-up use the packaged
 * fallback rate.
 *
 * The fold mirrors the built-in `tokenUsage` projection: one usage sample per
 * model attempt, a repeated sample for the same Turn and Step replaces the
 * previous one, and `llm/retry-started` closes that replacement slot so a
 * retried attempt counts on its own. Attempts that settle without a message
 * carry no route, so they are attributed to the route of the closest preceding
 * message and otherwise to a dedicated unattributed bucket. History inherited
 * through a fork is skipped on both sides so the project never bills it twice.
 */
import { RateBook } from './rates.js'

/** Projection key the Client reads through `useProjection`. */
export const PROJECTION_KEY = 'answerCost'

/** Bucket for attempts with no route attribution at all. */
const UNATTRIBUTED = '__unattributed__'

/** Bucket key for usage that predates every known top-up. */
const FALLBACK_PERIOD = '0'

/** Upper bound of project history read in one scan; larger sessions are skipped. */
const SCAN_BUDGET_BYTES = 256 * 1024 * 1024

/** Wallet polling cadence, in milliseconds. */
const BALANCE_POLL_MS = 5 * 60 * 1000

/** CBR refresh cadence, in milliseconds. */
const RATE_REFRESH_MS = 6 * 60 * 60 * 1000

/** A wallet increase above this amount counts as a top-up. */
const TOP_UP_EPSILON = 0.000001

const CASE_INSENSITIVE_PATHS = process.platform === 'win32'

/** The registry requires this service; without it the bundle stays inactive. */
export const inject = ['sessionProjections']

let pluginContext
let disposed = false
/** @type {RateBook | undefined} */
let book
/** Packaged fallback rate from the row configuration. */
let fallbackRate
/** Per-directory project scan state: `{ value, scanning, unavailable }`. */
const projects = new Map()
/** Every open Session's latest per-period usage, keyed by Session id. */
const liveStates = new Map()
/** Per-directory change counters; any live, scanned, or top-up change bumps it. */
const cwdVersions = new Map()

/** Fold identity for one directory; Windows compares paths case-insensitively. */
function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const slashed = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return CASE_INSENSITIVE_PATHS ? slashed.toLowerCase() : slashed
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function emptyBuckets() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** Exact token buckets of one provider usage sample, or undefined when unusable. */
function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens
  const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens
  if (!isCount(cacheRead) || !isCount(cacheWrite)) return undefined
  return { input: usage.inputTokens, cacheRead, cacheWrite, output: usage.outputTokens }
}

/** The last usage sample embedded in a compacted Assistant stream. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object' || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/** `provider/model` of a settled message, or undefined when it is not attributed. */
function routeOf(message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined
  if (source === null || typeof source !== 'object') return undefined
  const provider = source.provider
  const model = source.model
  return typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0
    ? provider + '/' + model
    : undefined
}

/** Whether an event's usage is priced by the pinned rate or the packaged fallback. */
function periodKeyOf(time) {
  if (book === undefined) return FALLBACK_PERIOD
  const period = book.periodAt(isCount(time) ? time : Date.now())
  return period === undefined ? FALLBACK_PERIOD : String(period.at)
}

function cloneRoutes(routes) {
  const copy = {}
  for (const key of Object.keys(routes)) copy[key] = { ...routes[key] }
  return copy
}

function clonePeriods(periods) {
  const copy = {}
  for (const key of Object.keys(periods)) copy[key] = cloneRoutes(periods[key])
  return copy
}

function addInto(routes, key, buckets) {
  const current = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : emptyBuckets()
  routes[key] = {
    input: current.input + buckets.input,
    cacheRead: current.cacheRead + buckets.cacheRead,
    cacheWrite: current.cacheWrite + buckets.cacheWrite,
    output: current.output + buckets.output,
  }
}

function subtractFrom(routes, key, buckets) {
  if (!Object.prototype.hasOwnProperty.call(routes, key)) return
  const current = routes[key]
  const next = {
    input: Math.max(0, current.input - buckets.input),
    cacheRead: Math.max(0, current.cacheRead - buckets.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - buckets.cacheWrite),
    output: Math.max(0, current.output - buckets.output),
  }
  if (next.input === 0 && next.cacheRead === 0 && next.cacheWrite === 0 && next.output === 0) delete routes[key]
  else routes[key] = next
}

/** Merge one route map into another, keeping both bucket sets additive. */
function mergeRoutes(target, source) {
  for (const key of Object.keys(source)) addInto(target, key, source[key])
}

/**
 * One committed event folded into per-period, per-route usage for this Session.
 * Events inherited through a fork are skipped: the parent Session owns them.
 */
function fold(state, event) {
  if (isCount(event.seq) && event.seq < state.cut) return state
  if (event.type === 'llm/retry-started') {
    const { turn, step } = event.data
    return state.last !== null && state.last.turn === turn && state.last.step === step
      ? { ...state, last: null }
      : state
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

  const usage = event.type === 'assistant/message' && event.data.usage !== undefined
    ? event.data.usage
    : lastStreamUsage(event.data.stream)
  const buckets = usage === undefined ? undefined : bucketsOf(usage)
  const route = event.type === 'assistant/message' ? routeOf(event.data.message) : undefined
  const period = periodKeyOf(event.time)

  if (buckets === undefined) {
    return route === undefined || route === state.lastRoute ? state : { ...state, lastRoute: route }
  }

  const key = route ?? state.lastRoute ?? UNATTRIBUTED
  const bucketsByPeriod = clonePeriods(state.buckets)
  if (bucketsByPeriod[period] === undefined) bucketsByPeriod[period] = {}
  const { turn, step } = event.data
  if (state.last !== null && state.last.turn === turn && state.last.step === step) {
    const previous = bucketsByPeriod[state.last.period]
    if (previous !== undefined) {
      subtractFrom(previous, state.last.key, state.last)
      if (Object.keys(previous).length === 0) delete bucketsByPeriod[state.last.period]
    }
  }
  if (bucketsByPeriod[period] === undefined) bucketsByPeriod[period] = {}
  addInto(bucketsByPeriod[period], key, buckets)
  return {
    buckets: bucketsByPeriod,
    last: { turn, step, key, period, ...buckets },
    lastRoute: route ?? state.lastRoute,
    cwd: state.cwd,
    sessionId: state.sessionId,
    cut: state.cut,
  }
}

/** Fold a stored Session's events into its per-period route usage. */
function foldLog(events, cut) {
  let state = { buckets: {}, last: null, lastRoute: null, cwd: null, sessionId: null, cut }
  for (const event of events) state = fold(state, event)
  return state.buckets
}

/** Read every Session of the project and keep per-session per-period usage. */
async function scanProject(key, entry) {
  const persistence = pluginContext?.get('sessionPersistence')
  if (persistence === undefined || persistence === null) {
    entry.unavailable = true
    return
  }
  const snapshots = await persistence.list()
  const sessions = {}
  let skipped = 0
  let bytes = 0
  for (const snapshot of snapshots) {
    if (disposed) return
    if (normalizeCwd(snapshot.header.cwd) !== key) continue
    const size = isCount(snapshot.sizeBytes) ? snapshot.sizeBytes : 0
    if (bytes + size > SCAN_BUDGET_BYTES) {
      skipped += 1
      continue
    }
    let handle
    try {
      handle = await persistence.open(snapshot.header.id, 'read')
    } catch {
      skipped += 1
      continue
    }
    try {
      const { events } = await handle.read(0, undefined)
      const cut = isCount(handle.inheritedEventCount) ? handle.inheritedEventCount : 0
      sessions[snapshot.header.id] = foldLog(events, cut)
      bytes += size
    } catch {
      skipped += 1
    } finally {
      try { await handle.close() } catch { /* a failed close must not abort the scan */ }
    }
  }
  if (disposed) return
  entry.value = Object.freeze({ sessions: Object.freeze(sessions), skipped })
  bumpCwd(key)
}

/** Start the project scan for a directory at most once per app run. */
function scheduleProjectScan(cwd) {
  if (disposed || pluginContext === undefined) return
  let entry = projects.get(cwd)
  if (entry === undefined) {
    entry = { value: null, scanning: false, unavailable: false }
    projects.set(cwd, entry)
  }
  if (entry.scanning || entry.value !== null || entry.unavailable) return
  entry.scanning = true
  void scanProject(cwd, entry)
    .catch(() => { /* an unreadable project simply shows no project total */ })
    .finally(() => { entry.scanning = false })
}

/** Bump the change counter of one directory, so its views rebuild. */
function bumpCwd(cwd) {
  if (cwd === null) return
  cwdVersions.set(cwd, (cwdVersions.get(cwd) ?? 0) + 1)
}

/** Bump every directory, after the period list changed. */
function bumpAll() {
  for (const key of [...cwdVersions.keys()]) bumpCwd(key)
}

/**
 * The project union for one Session: scanned closed Sessions plus the live
 * usage of every open Session in the same directory, the current one included.
 * @returns per-period merged routes and counts, or null before the scan.
 */
function projectFor(state) {
  if (state.cwd === null) return null
  const entry = projects.get(state.cwd)
  const scanned = entry === undefined ? undefined : entry.value
  if (scanned === undefined || scanned === null) return null
  const perSession = new Map()
  for (const id of Object.keys(scanned.sessions)) perSession.set(id, scanned.sessions[id])
  for (const [id, live] of liveStates) {
    if (live.cwd !== state.cwd) continue
    perSession.set(id, live.buckets)
  }
  if (state.sessionId !== null) perSession.set(state.sessionId, state.buckets)
  const buckets = {}
  for (const sessionBuckets of perSession.values()) {
    for (const period of Object.keys(sessionBuckets)) {
      if (buckets[period] === undefined) buckets[period] = {}
      mergeRoutes(buckets[period], sessionBuckets[period])
    }
  }
  return { buckets, sessions: perSession.size, skipped: scanned.skipped }
}

/** Identity-stable Client view: a new object only when its inputs change. */
let cachedState
let cachedVersion
let cachedView

function viewOf(state) {
  if (state.sessionId !== null) {
    const previous = liveStates.get(state.sessionId)
    if (previous === undefined || previous.buckets !== state.buckets || previous.cwd !== state.cwd) {
      liveStates.set(state.sessionId, { cwd: state.cwd, buckets: state.buckets })
      bumpCwd(state.cwd)
    }
  }
  const cwdVersion = state.cwd === null ? 0 : (cwdVersions.get(state.cwd) ?? 0)
  const version = `${cwdVersion}:${book === undefined ? 0 : book.version}`
  if (cachedState === state && cachedVersion === version) return cachedView
  cachedState = state
  cachedVersion = version
  cachedView = {
    periods: book === undefined ? [] : book.snapshotPeriods(),
    buckets: state.buckets,
    project: projectFor(state),
  }
  return cachedView
}

/** Per-period usage maps with validated buckets. */
function parseBucketsByPeriod(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('answer-cost: buckets must be an object')
  }
  const periods = {}
  for (const period of Object.keys(value)) {
    if (!/^\d+$/.test(period)) throw new TypeError('answer-cost: invalid period key')
    periods[period] = parseRoutes(value[period])
  }
  return periods
}

function parseBuckets(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('answer-cost: token buckets must be an object')
  if (!isCount(value.input) || !isCount(value.cacheRead) || !isCount(value.cacheWrite) || !isCount(value.output)) {
    throw new TypeError('answer-cost: token buckets must be non-negative integers')
  }
  return { input: value.input, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, output: value.output }
}

function parseRoutes(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('answer-cost: routes must be an object')
  }
  const routes = {}
  for (const key of Object.keys(value)) routes[key] = parseBuckets(value[key])
  return routes
}

function parsePeriods(value) {
  if (!Array.isArray(value)) return []
  const periods = []
  for (const period of value) {
    if (period === null || typeof period !== 'object') continue
    if (typeof period.at !== 'number' || !Number.isFinite(period.at)) continue
    if (typeof period.rate !== 'number' || !Number.isFinite(period.rate) || period.rate <= 0) continue
    periods.push({ at: period.at, rate: period.rate })
  }
  return periods.sort((left, right) => left.at - right.at)
}

function parseProject(value) {
  if (value === null) return null
  if (typeof value !== 'object') throw new TypeError('answer-cost: project must be an object or null')
  if (!isCount(value.sessions) || !isCount(value.skipped)) throw new TypeError('answer-cost: invalid project counts')
  return { buckets: parseBucketsByPeriod(value.buckets), sessions: value.sessions, skipped: value.skipped }
}

/** Validation stand-ins: the registry only calls `parse`. */
const viewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('answer-cost: view must be an object')
    }
    return {
      periods: parsePeriods(value.periods),
      buckets: parseBucketsByPeriod(value.buckets),
      project: parseProject(value.project === undefined ? null : value.project),
    }
  },
}

const stateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('answer-cost: state must be an object')
    }
    if (value.last !== null && typeof value.last !== 'object') throw new TypeError('answer-cost: invalid last sample')
    if (value.lastRoute !== null && typeof value.lastRoute !== 'string') throw new TypeError('answer-cost: invalid last route')
    if (value.cwd !== null && typeof value.cwd !== 'string') throw new TypeError('answer-cost: invalid cwd')
    if (value.sessionId !== null && typeof value.sessionId !== 'string') throw new TypeError('answer-cost: invalid session id')
    if (!isCount(value.cut)) throw new TypeError('answer-cost: invalid inherited cut')
    return {
      buckets: parseBucketsByPeriod(value.buckets),
      last: value.last === null
        ? null
        : {
          ...parseBuckets(value.last),
          turn: value.last.turn,
          step: value.last.step,
          key: value.last.key,
          period: value.last.period,
        },
      lastRoute: value.lastRoute,
      cwd: value.cwd,
      sessionId: value.sessionId,
      cut: value.cut,
    }
  },
}

/** This Session's usage plus the project it belongs to, both per period. */
export const definition = {
  key: PROJECTION_KEY,
  stateVersion: 4,
  stateSchema,
  init: (header, inheritedEventCount) => {
    const cwd = normalizeCwd(header.cwd)
    const state = {
      buckets: {},
      last: null,
      lastRoute: null,
      cwd,
      sessionId: String(header.id),
      cut: isCount(inheritedEventCount) ? inheritedEventCount : 0,
    }
    if (cwd !== null) scheduleProjectScan(cwd)
    return state
  },
  apply: fold,
  wire: {
    viewSchema,
    view: viewOf,
    summary: false,
  },
}

/** Compare the wallet with the last seen one; a top-up pins the current rate. */
async function pollBalance() {
  if (disposed || book === undefined) return
  const account = pluginContext?.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.getBalance !== 'function') return
  const metadata = {
    version: 'answer-cost',
    locale: 'en',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  let balance
  try {
    balance = await account.getBalance(metadata)
    /* v8 ignore next -- a signed-out or failed read simply leaves the rate pinned */
  } catch {
    return
  }
  if (balance === null || balance === undefined || balance.status !== 'ready') return
  const wallets = Array.isArray(balance.value) ? balance.value : []
  const wallet = wallets.find(candidate => candidate !== null && typeof candidate === 'object' && candidate.currency === 'USD')
    ?? wallets.find(candidate => candidate !== null && typeof candidate === 'object' && typeof candidate.balance === 'string')
  if (wallet === undefined) return
  const amount = Number(wallet.balance)
  if (!Number.isFinite(amount)) return
  const previous = book.lastBalance
  const changed = previous === null || previous.currency !== wallet.currency || previous.amount !== amount
  if (!changed) return
  book.lastBalance = { currency: wallet.currency, amount }
  if (previous !== null && previous.currency === wallet.currency && amount > previous.amount + TOP_UP_EPSILON) {
    const period = await book.recordTopUp(Date.now(), fallbackRate)
    if (period !== null) bumpAll()
    return
  }
  await book.persist()
}

/** Refresh the online rate series; a period already pinned never changes. */
async function refreshRates() {
  if (book === undefined || disposed) return
  try {
    await book.refresh()
  } catch {
    // Offline simply means the pinned rate stays as it is.
  }
}

/**
 * Register the projection for the plugin's lifetime; the owning fiber releases
 * it on unload.
 * @param ctx - Host plugin context.
 * @param config - the same row configuration the Client half receives.
 */
export async function apply(ctx, config) {
  pluginContext = ctx
  disposed = false
  const options = config !== null && typeof config === 'object' ? config : {}
  const configuredRate = typeof options.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0
    ? options.rate
    : undefined
  fallbackRate = configuredRate
  book = new RateBook({
    file: typeof options.ratesFile === 'string' && options.ratesFile.length > 0 ? options.ratesFile : undefined,
    log: ctx.logger,
  })
  await book.load()

  const timers = [
    setInterval(() => { void pollBalance() }, BALANCE_POLL_MS),
    setInterval(() => { void refreshRates() }, RATE_REFRESH_MS),
  ]
  ctx.effect(() => () => {
    disposed = true
    for (const timer of timers) clearInterval(timer)
    pluginContext = undefined
    book = undefined
    projects.clear()
    liveStates.clear()
    cwdVersions.clear()
    cachedState = undefined
    cachedVersion = undefined
    cachedView = undefined
  }, 'answer-cost: project, rate and balance lifetime')

  await ctx.sessionProjections.register(definition)
  void refreshRates()
  void pollBalance()
}
