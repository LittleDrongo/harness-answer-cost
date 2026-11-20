/**
 * Answer cost — host half.
 *
 * Publishes session-wide provider token usage grouped by model route, so the
 * Chat entry can price the whole session without re-folding the log in the
 * browser and without limiting the total to the loaded transcript window.
 *
 * The fold mirrors the built-in `tokenUsage` projection: one usage sample per
 * model attempt, a repeated sample for the same Turn and Step replaces the
 * previous one, and `llm/retry-started` closes that replacement slot so a
 * retried attempt counts on its own. Attempts that settle without a message
 * carry no route, so they are attributed to the route of the closest preceding
 * message and otherwise to a dedicated unattributed bucket.
 *
 * Prices and the display rate stay in the Client configuration; this unit only
 * reports exact token buckets per route and makes no request.
 */

/** Projection key the Client reads through `useProjection`. */
export const PROJECTION_KEY = 'answerCost'

/** Bucket for attempts with no route attribution at all. */
const UNATTRIBUTED = '__unattributed__'

/** The registry requires this service; without it the bundle stays inactive. */
export const inject = ['sessionProjections']

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

function cloneRoutes(routes) {
  const copy = {}
  for (const key of Object.keys(routes)) copy[key] = { ...routes[key] }
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

/**
 * One committed event folded into per-route session usage.
 * @param state - usage accumulated so far.
 * @param event - the committed Session event.
 * @returns the next state, or the same reference for unrelated events.
 */
function fold(state, event) {
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

  if (buckets === undefined) {
    return route === undefined || route === state.lastRoute ? state : { ...state, lastRoute: route }
  }

  const key = route ?? state.lastRoute ?? UNATTRIBUTED
  const routes = cloneRoutes(state.routes)
  const { turn, step } = event.data
  if (state.last !== null && state.last.turn === turn && state.last.step === step) {
    subtractFrom(routes, state.last.key, state.last)
  }
  addInto(routes, key, buckets)
  return {
    routes,
    last: { turn, step, key, ...buckets },
    lastRoute: route ?? state.lastRoute,
    view: { routes: cloneRoutes(routes) },
  }
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

/** Validation stand-ins: the registry only calls `parse`. */
const viewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('answer-cost: view must be an object')
    }
    return { routes: parseRoutes(value.routes) }
  },
}

const stateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('answer-cost: state must be an object')
    }
    if (value.last !== null && typeof value.last !== 'object') throw new TypeError('answer-cost: invalid last sample')
    if (value.lastRoute !== null && typeof value.lastRoute !== 'string') throw new TypeError('answer-cost: invalid last route')
    const routes = parseRoutes(value.routes)
    return {
      routes,
      last: value.last === null ? null : { ...parseBuckets(value.last), turn: value.last.turn, step: value.last.step, key: value.last.key },
      lastRoute: value.lastRoute,
      view: { routes: cloneRoutes(routes) },
    }
  },
}

/** Session-wide usage per model route, exposed as a Client view. */
export const definition = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ routes: {}, last: null, lastRoute: null, view: { routes: {} } }),
  apply: fold,
  wire: {
    viewSchema,
    view: (state) => state.view,
    summary: false,
  },
}

/**
 * Register the projection for the plugin's lifetime; the owning fiber releases
 * it on unload.
 * @param ctx - Host plugin context.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(definition)
}
