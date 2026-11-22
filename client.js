/**
 * Answer cost — browser half.
 *
 * Adds one entry to the completed-Turn tail under a Chat answer: the estimated
 * price of that answer, priced from the exact per-Turn token accounting the
 * Chat layer already derives. Chain of custody of the number:
 *
 *   Session log → Chat `turn-tail` Turn data (`tokenUsage`) → this entry.
 *
 * Nothing is re-folded here and no request is made; the entry only multiplies
 * provider-reported token buckets by the per-route prices in its configuration.
 */
window.__ModuleLoader__.load({
  id: '@local/answer-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this entry. */
    const NS = 'answerCost'

    /**
     * Peak-rate DeepSeek prices, USD per 1M tokens, as the provider publishes
     * them. Off-peak rates are lower, so a peak default overstates rather than
     * understates the bill; every value is overridable per route in the row
     * configuration. Keys use the wildcard form (a leading `*` followed by
     * `/model`) because the same model is served through more than one provider
     * route (`deepseek-account` for the signed-in account, `deepseek-official`
     * for an API key).
     */
    const DEFAULT_PRICES = {
      '*/deepseek-flash': { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 },
      '*/deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96 },
    }

    /**
     * Display currency and its rate per 1 US dollar. Provider prices stay in
     * USD; this is the conversion applied for display. The packaged rate is the
     * Central Bank of Russia rate for 20.11.2026 (81.9290 RUB per USD) and is
     * never fetched — no plugin code makes a network request, so the rate is
     * only as fresh as the configuration.
     */
    const DEFAULT_CURRENCY = 'RUB'
    const DEFAULT_RATE = 82.1911

    const CSS = `
.answer-cost-root {
  position: relative; display: flex; align-items: flex-start;
}
.answer-cost-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  width: calc(100% + 6px);
  margin-left: -6px; padding: 6px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
}
.answer-cost-side { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.answer-cost-side-right { justify-content: flex-end; }
.answer-cost-trigger svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); flex: none; }
.answer-cost-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.answer-cost-trigger[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) {
  .answer-cost-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
}
/* Out of flow above the pill: the tail sits at the bottom of the transcript,
   so an in-flow panel would grow past the viewport and move the action row. */
.answer-cost-panel {
  position: absolute; left: -6px; bottom: calc(100% + 8px); z-index: 2;
  box-sizing: border-box; width: max-content; min-width: min(300px, calc(100vw - 48px)); max-width: min(420px, calc(100vw - 48px));
  padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 18px;
}
.answer-cost-title {
  display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.answer-cost-title .answer-cost-amount { font-variant-numeric: tabular-nums; }
.answer-cost-details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 16px; margin: 0; }
.answer-cost-details dt, .answer-cost-details dd { min-width: 0; margin: 0; }
.answer-cost-details dt { color: var(--dsw-alias-label-tertiary); }
.answer-cost-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
.answer-cost-note { margin: 8px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.answer-cost-balance {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  padding: 1px 8px; border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.answer-cost-balance svg { width: 14px; height: 14px; flex: none; }
.answer-cost-balance-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.answer-cost-visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}
@media (prefers-reduced-motion: no-preference) {
  .answer-cost-trigger { transition: background 80ms ease; }
}
`

    /**
     * Install the entry's stylesheet once for the plugin lifetime; the owning
     * effect removes the element on unload.
     * @returns the disposer, or undefined when no document exists.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === null) return undefined
      const style = document.createElement('style')
      style.setAttribute('data-answer-cost', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    const LOCALES = {
      en: {
        approx: '≈ {amount}',
        bound: '< {amount}',
        badgeTokens: '{tokens} tok',
        sessionInline: 'session {amount}',
        sessionRow: 'Session',
        sessionNote: 'Session total covers the whole Session log, including earlier turns.',
        sessionPartial: 'Routes without a price are not part of the session total.',
        projectInline: 'project {amount}',
        projectRow: 'Project',
        projectNote: 'Project total covers every Session of this folder ({count} in total) and is computed when a Session opens.',
        projectPartial: '{count} project Sessions could not be read and are not in the total.',
        hint: 'Estimated cost of this answer — open the token breakdown',
        title: 'Estimated cost',
        model: 'Model',
        input: 'Input (cache miss)',
        cacheRead: 'Cached input',
        cacheWrite: 'Cache write',
        output: 'Output',
        totalTokens: 'Total tokens',
        inUsd: 'In US dollars',
        steps: 'Steps',
        prices: 'Prices per 1M tokens (USD): input {input}, cached input {cacheRead}, cache write {cacheWrite}, output {output}.',
        rateTopUp: 'Rate from the top-up on {date}: {rate} per 1 US dollar.',
        rateFixed: 'No top-up detected yet; the packaged rate is used: {rate} per 1 US dollar.',
        rateByTopUp: 'Session and project totals use the rate pinned at each top-up.',
        balanceHint: 'Balance left on the account: dollars, and roubles at the pinned top-up rate.',
        unpriced: 'No price is configured for {route}, so only token usage is shown.',
        severalModels: 'several models',
        multiRoute: 'This answer used {count} model routes, so only token usage is shown.',
        noRoute: 'This answer reports no model route, so only token usage is shown.',
        unknownRoute: 'not reported',
        estimate: 'Estimated from the plugin configuration. Defaults are peak-rate prices.',
      },
      ru: {
        approx: '≈ {amount}',
        bound: '< {amount}',
        badgeTokens: 'токены: {tokens}',
        sessionInline: 'сессия {amount}',
        sessionRow: 'Сессия',
        sessionNote: 'Итог сессии — по всему журналу, включая прошлые ходы.',
        sessionPartial: 'Маршруты без цены не вошли в итог сессии.',
        projectInline: 'проект {amount}',
        projectRow: 'Проект',
        projectNote: 'Итог проекта — все сессии этой папки (всего {count}); считается при открытии сессии.',
        projectPartial: 'Не удалось прочитать {count} сессий проекта — они не вошли в итог.',
        hint: 'Оценка стоимости ответа — показать расход токенов',
        title: 'Оценка стоимости',
        model: 'Модель',
        input: 'Ввод без кэша',
        cacheRead: 'Ввод из кэша',
        cacheWrite: 'Запись в кэш',
        output: 'Вывод',
        totalTokens: 'Всего токенов',
        inUsd: 'В долларах',
        steps: 'Шаги',
        prices: 'Цены за 1 млн токенов (USD): ввод без кэша {input}, ввод из кэша {cacheRead}, запись в кэш {cacheWrite}, вывод {output}.',
        rateTopUp: 'Курс с пополнения {date}: {rate} за 1 доллар США.',
        rateFixed: 'Пополнение ещё не зафиксировано — используется курс из настроек: {rate} за 1 доллар США.',
        rateByTopUp: 'Итоги сессии и проекта считаются по курсу, зафиксированному на момент каждого пополнения.',
        balanceHint: 'Остаток на счёте: доллары и рубли по курсу последнего пополнения.',
        unpriced: 'Для {route} цена не задана — показан только расход токенов.',
        severalModels: 'несколько моделей',
        multiRoute: 'В ответе участвовало несколько моделей ({count}), поэтому показан только расход токенов.',
        noRoute: 'В ответе не указана модель, поэтому показан только расход токенов.',
        unknownRoute: 'не указана',
        estimate: 'Оценка по ценам из настроек плагина. По умолчанию — пиковые тарифы.',
      },
      zh: {
        approx: '≈ {amount}',
        bound: '< {amount}',
        badgeTokens: '{tokens} 令牌',
        sessionInline: '会话 {amount}',
        sessionRow: '会话',
        sessionNote: '会话总计覆盖整个日志，包括此前的轮次。',
        sessionPartial: '未配置价格的路由不计入会话总计。',
        projectInline: '项目 {amount}',
        projectRow: '项目',
        projectNote: '项目总计覆盖该文件夹的所有会话（共 {count} 个），打开会话时计算。',
        projectPartial: '{count} 个会话无法读取，未计入项目总计。',
        hint: '本次回答的费用估算 — 展开查看令牌明细',
        title: '费用估算',
        model: '模型',
        input: '输入（未缓存）',
        cacheRead: '缓存输入',
        cacheWrite: '缓存写入',
        output: '输出',
        totalTokens: '总令牌',
        inUsd: '美元金额',
        steps: '步骤',
        prices: '每百万令牌价格（USD）：输入 {input}，缓存读取 {cacheRead}，缓存写入 {cacheWrite}，输出 {output}。',
        rateTopUp: '按 {date} 充值时锁定的汇率：1 美元 = {rate}。',
        rateFixed: '尚未检测到充值，使用配置汇率：1 美元 = {rate}。',
        rateByTopUp: '会话与项目总计按每次充值时锁定的汇率计算。',
        balanceHint: '账户余额：美元，以及按最近充值汇率折算的卢布。',
        unpriced: '{route} 未配置价格，仅显示令牌用量。',
        severalModels: '多个模型',
        multiRoute: '该回答使用了 {count} 条模型路由，因此仅显示令牌用量。',
        noRoute: '该回答未报告模型路由，因此仅显示令牌用量。',
        unknownRoute: '未报告',
        estimate: '按插件配置中的价格估算，默认为高峰费率。',
      },
    }

    /** A finite non-negative number, or the fallback. */
    function countOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
    }

    /** A finite non-negative price, or the fallback. */
    function priceOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
    }

    /**
     * Merge the row configuration over the packaged defaults. An exact
     * `provider/model` entry is seeded field by field from the wildcard entry
     * for the same model when one exists, so overriding only the output rate
     * cannot silently make input free; a model without a wildcard starts from
     * zero.
     */
    function normalizeConfig(config) {
      const prices = { ...DEFAULT_PRICES }
      const overrides = config !== null && typeof config === 'object'
        && config.prices !== null && typeof config.prices === 'object'
        ? config.prices
        : {}
      for (const key of Object.keys(overrides)) {
        const entry = overrides[key]
        if (entry === null || typeof entry !== 'object') continue
        const slash = key.indexOf('/')
        const wildcard = slash >= 0 ? prices['*/' + key.slice(slash + 1)] : undefined
        const base = Object.prototype.hasOwnProperty.call(prices, key)
          ? prices[key]
          : wildcard !== undefined
            ? wildcard
            : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        prices[key] = {
          input: priceOr(entry.input, base.input),
          cacheRead: priceOr(entry.cacheRead, base.cacheRead),
          cacheWrite: priceOr(entry.cacheWrite, base.cacheWrite),
          output: priceOr(entry.output, base.output),
        }
      }
      const currency = config !== null && typeof config === 'object'
        && typeof config.currency === 'string' && /^[A-Za-z]{3}$/.test(config.currency)
        ? config.currency.toUpperCase()
        : DEFAULT_CURRENCY
      const configuredRate = config !== null && typeof config === 'object' ? config.rate : undefined
      const rate = currency === 'USD'
        ? 1
        : typeof configuredRate === 'number' && Number.isFinite(configuredRate) && configuredRate > 0
          ? configuredRate
          : currency === 'RUB' ? DEFAULT_RATE : 1
      return { currency, rate, prices }
    }

    /** `provider/model` of a route, or undefined when the route is malformed. */
    function routeKeyOf(route) {
      return route !== null && typeof route === 'object'
        && typeof route.provider === 'string' && typeof route.model === 'string'
        && route.provider.length > 0 && route.model.length > 0
        ? route.provider + '/' + route.model
        : undefined
    }

    /**
     * Price configured for one route key: an exact `provider/model` entry,
     * then the wildcard entry for that model, then nothing.
     */
    function priceForKey(prices, key) {
      if (typeof key !== 'string' || key.length === 0) return undefined
      if (Object.prototype.hasOwnProperty.call(prices, key)) return prices[key]
      const slash = key.indexOf('/')
      if (slash < 0) return undefined
      const wildcard = '*/' + key.slice(slash + 1)
      return Object.prototype.hasOwnProperty.call(prices, wildcard) ? prices[wildcard] : undefined
    }

    /** Whether a price entry states no price at all. */
    function isZeroPrice(price) {
      return price.input === 0 && price.cacheRead === 0 && price.cacheWrite === 0 && price.output === 0
    }

    /**
     * Resolve the price for one exact route object.
     */
    function resolvePrice(prices, route) {
      const key = routeKeyOf(route)
      if (key === undefined) return null
      const price = priceForKey(prices, key)
      return price === undefined ? null : { key, price }
    }

    /**
     * Price one Turn's exact usage. Only a single attributed route can be
     * priced: the usage buckets are Turn aggregates, so splitting them across
     * several routes would be a guess.
     */
    function priceOf(usage, prices) {
      const routes = Array.isArray(usage.routes) ? usage.routes : []
      if (routes.length !== 1) return null
      const resolved = resolvePrice(prices, routes[0])
      if (resolved === null) return null
      const { key, price } = resolved
      // A wholly zero entry configures no price at all; treat it as unpriced
      // rather than claiming the answer was free.
      if (isZeroPrice(price)) return null
      const inputTokens = countOr(usage.uncachedInputTokens, 0)
      const cacheReadTokens = countOr(usage.cacheReadTokens, 0)
      const cacheWriteTokens = countOr(usage.cacheWriteTokens, 0)
      const outputTokens = countOr(usage.outputTokens, 0)
      const amount = (
        inputTokens * price.input
        + cacheReadTokens * price.cacheRead
        + cacheWriteTokens * price.cacheWrite
        + outputTokens * price.output
      ) / 1e6
      return Number.isFinite(amount) && amount >= 0 ? { amount, key, price } : null
    }

    /**
     * Active locale tag for number formatting, so digits and currency follow the
     * application language rather than the browser's own preference.
     */
    function activeTag(locale) {
      try {
        const snapshot = locale !== undefined && locale !== null && typeof locale.getLocale === 'function'
          ? locale.getLocale()
          : undefined
        return snapshot !== undefined && snapshot !== null && typeof snapshot.active === 'string'
          ? snapshot.active
          : undefined
      } catch {
        return undefined
      }
    }

    /** Currency text with enough decimals for sub-cent amounts. */
    function formatCost(amount, currency, tag) {
      const fraction = amount >= 1 ? 2 : amount >= 0.1 ? 3 : 4
      const format = (value, digits) => {
        try {
          return new Intl.NumberFormat(tag, {
            style: 'currency',
            currency,
            minimumFractionDigits: amount >= 0.1 ? 2 : digits,
            maximumFractionDigits: digits,
          }).format(value)
        } catch {
          return currency + ' ' + value.toFixed(digits)
        }
      }
      // A round zero keeps a plain zero; a non-zero amount that would round to
      // zero is reported as a bound instead of looking free.
      if (amount > 0 && amount < 0.00005) return '< ' + format(0.0001, 4)
      return format(amount, fraction)
    }

    /** Compact token count for the resting label. */
    function formatTokens(value, tag) {
      try {
        return new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(value)
      }
    }

    /** Exact grouped token count for the breakdown. */
    function formatExactTokens(value, tag) {
      try {
        return new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(value)
      } catch {
        return String(value)
      }
    }

    /** Plain price text, keeping the provider's small decimals. */
    function formatPrice(value, tag) {
      try {
        return new Intl.NumberFormat(tag, { maximumFractionDigits: 4 }).format(value)
      } catch {
        return String(value)
      }
    }

    /** Currency-styled rate, as an amount per one US dollar. */
    function formatRate(value, currency, tag) {
      try {
        return new Intl.NumberFormat(tag, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
      } catch {
        return currency + ' ' + String(value)
      }
    }

    /**
     * Price one route map: per-route token buckets multiplied by the same
     * prices as one answer.
     * @param routes - route key → token buckets, or undefined.
     * @param prices - per-route prices in USD per 1M tokens.
     * @returns USD amount, token total, and priced/unpriced route counts.
     */
    function routesCostOf(routes, prices) {
      const totals = { usd: 0, tokens: 0, pricedRoutes: 0, unpricedRoutes: 0 }
      if (routes === null || routes === undefined || typeof routes !== 'object') return totals
      for (const key of Object.keys(routes)) {
        const buckets = routes[key]
        if (buckets === null || typeof buckets !== 'object') continue
        const input = countOr(buckets.input, 0)
        const cacheRead = countOr(buckets.cacheRead, 0)
        const cacheWrite = countOr(buckets.cacheWrite, 0)
        const output = countOr(buckets.output, 0)
        totals.tokens += input + cacheRead + cacheWrite + output
        const price = priceForKey(prices, key)
        if (price === undefined || isZeroPrice(price)) {
          if (input + cacheRead + cacheWrite + output > 0) totals.unpricedRoutes += 1
          continue
        }
        totals.usd += (input * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + output * price.output) / 1e6
        totals.pricedRoutes += 1
      }
      return totals
    }

    /** Local date and time of a top-up instant. */
    function formatInstant(at, tag) {
      try {
        return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
      } catch {
        return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    /**
     * Rate in force at one instant: the newest top-up period at or before it.
     * @param periods - list of { at, rate } from the projection, oldest first.
     * @param time - epoch milliseconds of the request.
     * @param fallback - packaged rate used before the first known top-up.
     * @returns the rate, the period start, and whether a pinned period was used.
     */
    function rateForTime(periods, time, fallback) {
      const list = Array.isArray(periods) ? periods : []
      let found
      for (const period of list) {
        if (period === null || typeof period !== "object") continue
        if (typeof period.at !== "number" || typeof period.rate !== "number") continue
        if (period.at <= time) found = period
        else break
      }
      if (found === undefined) return { rate: fallback, at: undefined, pinned: false }
      return { rate: found.rate, at: found.at, pinned: true }
    }

    /** Rate of the newest pinned top-up period, or the packaged fallback. */
    function latestRate(periods, fallback) {
      const list = Array.isArray(periods) ? periods : []
      let rate = fallback
      let latest = -Infinity
      for (const period of list) {
        if (period === null || typeof period !== 'object') continue
        if (typeof period.at !== 'number' || typeof period.rate !== 'number') continue
        if (period.at >= latest) {
          latest = period.at
          rate = period.rate
        }
      }
      return rate
    }

    /**
     * Price per-period route maps: each period cost in USD times the rate that
     * was pinned at the top-up starting it.
     * @param buckets - map of period start to route buckets.
     * @param prices - per-route prices in USD per 1M tokens.
     * @param periods - list of { at, rate } from the projection.
     * @param fallback - packaged rate used for usage before the first top-up.
     * @returns USD and RUB totals, token total, unpriced routes, and whether any
     *   period fell back to the packaged rate.
     */
    function periodsCostOf(buckets, prices, periods, fallback) {
      const totals = { usd: 0, rub: 0, tokens: 0, pricedRoutes: 0, unpricedRoutes: 0, estimated: false }
      if (buckets === null || buckets === undefined || typeof buckets !== "object") return totals
      const byStart = new Map()
      for (const period of Array.isArray(periods) ? periods : []) {
        if (period !== null && typeof period === "object" && typeof period.at === "number") byStart.set(String(period.at), period.rate)
      }
      for (const period of Object.keys(buckets)) {
        const totalsForPeriod = routesCostOf(buckets[period], prices)
        totals.tokens += totalsForPeriod.tokens
        totals.unpricedRoutes += totalsForPeriod.unpricedRoutes
        if (totalsForPeriod.pricedRoutes === 0) continue
        const pinned = byStart.has(period)
        const rate = pinned ? byStart.get(period) : fallback
        if (!pinned) totals.estimated = true
        totals.usd += totalsForPeriod.usd
        totals.rub += totalsForPeriod.usd * rate
        totals.pricedRoutes += totalsForPeriod.pricedRoutes
      }
      return totals
    }

    /**
     * This Session's own total from the host projection.
     * @param view - the answerCost wire view, or undefined while absent.
     * @param prices - per-route prices in USD per 1M tokens.
     * @returns USD and RUB totals, or null when nothing is priced.
     */
    function sessionCostOf(view, prices, fallbackRate) {
      if (view === null || view === undefined || typeof view !== "object") return null
      const totals = periodsCostOf(view.buckets, prices, view.periods, fallbackRate)
      if (totals.pricedRoutes === 0 || !Number.isFinite(totals.usd)) return null
      return {
        usd: totals.usd,
        rub: totals.rub,
        tokens: totals.tokens,
        unpricedRoutes: totals.unpricedRoutes,
        estimated: totals.estimated,
      }
    }

    /**
     * The whole project from the host projection: it already merges every
     * Session of the folder, this one included.
     * @param view - the answerCost wire view, or undefined while absent.
     * @param prices - per-route prices in USD per 1M tokens.
     * @returns USD and RUB totals plus the Session counts, or null before the scan.
     */
    function projectCostOf(view, prices, fallbackRate) {
      if (view === null || view === undefined || typeof view !== "object") return null
      const project = view.project
      if (project === null || project === undefined || typeof project !== "object") return null
      const totals = periodsCostOf(project.buckets, prices, view.periods, fallbackRate)
      // Every route unpriced means the total would be a silent zero, not a total.
      if (totals.pricedRoutes === 0 && totals.unpricedRoutes > 0) return null
      if (!Number.isFinite(totals.usd)) return null
      return {
        usd: totals.usd,
        rub: totals.rub,
        sessions: countOr(project.sessions, 0),
        skipped: countOr(project.skipped, 0),
        unpricedRoutes: totals.unpricedRoutes,
        estimated: totals.estimated,
      }
    }

    /**
     * The composer dock pill: the wallet balance in dollars, and in roubles at
     * the newest pinned top-up rate.
     * @param settings - display currency and fallback rate.
     * @param locale - the Client locale service, read for number formatting.
     * @returns the React entry for the composer dock.
     */
    function createBalancePill(settings, locale) {
      return function BalancePill({ t, useProjection }) {
        const view = typeof useProjection === 'function' ? useProjection('answerCost') : undefined
        const balance = view !== null && view !== undefined && typeof view === 'object' ? view.balance : undefined
        if (balance === null || balance === undefined || typeof balance !== 'object') return null
        if (typeof balance.amount !== 'number' || !Number.isFinite(balance.amount)) return null
        const tag = activeTag(locale)
        const walletCurrency = typeof balance.currency === 'string' && /^[A-Za-z]{3}$/.test(balance.currency)
          ? balance.currency.toUpperCase()
          : 'USD'
        const usdText = formatCost(balance.amount, walletCurrency, tag)
        const showRoubles = walletCurrency === 'USD' && settings.currency !== 'USD'
        const rate = latestRate(view.periods, settings.rate)
        const label = showRoubles
          ? usdText + ' / ' + formatCost(balance.amount * rate, settings.currency, tag)
          : usdText
        return h('span', { className: 'answer-cost-balance', title: t('balanceHint') },
          h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
            h('circle', { cx: 8, cy: 8, r: 6.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
            h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }),
          ),
          h('span', { className: 'answer-cost-balance-label' }, label),
        )
      }
    }

    /**
     * Build the slot entry bound to one normalized configuration.
     * @param settings - display currency, its rate per USD, and per-route prices.
     * @param locale - the Client locale service, read for number formatting.
     * @returns the React entry for `conversation.chat.turnTail`.
     */
    function createAnswerCost(settings, locale) {
      return function AnswerCost({ turn, t, useProjection }) {
        const [open, setOpen] = React.useState(false)
        const rootRef = React.useRef(null)
        const panelId = React.useId()
        const hintId = React.useId()
        // Session-wide usage comes already folded from the Host projection, so
        // the total is not limited to the loaded transcript window.
        const sessionView = typeof useProjection === 'function' ? useProjection('answerCost') : undefined

        // The tail sits at the bottom of the transcript, so the breakdown opens
        // upward; Escape and a press outside dismiss it like a host stat dialog.
        React.useEffect(() => {
          if (!open || typeof document === 'undefined') return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          const onPointerDown = (event) => {
            const root = rootRef !== null && rootRef !== undefined ? rootRef.current : null
            if (root !== null && typeof root.contains === 'function' && root.contains(event.target)) return
            setOpen(false)
          }
          document.addEventListener('keydown', onKeyDown)
          document.addEventListener('pointerdown', onPointerDown, true)
          return () => {
            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('pointerdown', onPointerDown, true)
          }
        }, [open])

        const detail = turn !== null && turn !== undefined && turn.data !== null && turn.data !== undefined
          ? turn.data.get('turn-tail')
          : undefined
        if (detail === undefined || detail === null || detail.closing === undefined || detail.closing === null) return null
        const usage = detail.tokenUsage
        if (usage === undefined || usage === null || !(countOr(usage.totalTokens, 0) > 0)) return null

        const tag = activeTag(locale)
        const priced = priceOf(usage, settings.prices)
        const routes = Array.isArray(usage.routes) ? usage.routes : []
        const singleRoute = routes.length === 1 ? routeKeyOf(routes[0]) : undefined
        const fallbackRate = settings.rate

        // The answer is priced with the rate pinned by the last top-up before it.
        const writtenAt = detail.closing.time !== undefined ? detail.closing.time : detail.time
        const answerRate = rateForTime(
          sessionView === undefined || sessionView === null ? undefined : sessionView.periods,
          writtenAt,
          fallbackRate,
        )
        const answerRub = priced === null ? undefined : priced.amount * answerRate.rate
        const rubText = answerRub === undefined ? undefined : formatCost(answerRub, settings.currency, tag)
        const usdText = priced === null ? undefined : formatCost(priced.amount, 'USD', tag)

        const session = sessionCostOf(sessionView, settings.prices, fallbackRate)
        const project = projectCostOf(sessionView, settings.prices, fallbackRate)
        const pair = (rub, usd) => settings.currency === 'USD'
          ? formatCost(usd, 'USD', tag)
          : formatCost(rub, settings.currency, tag) + ' / ' + formatCost(usd, 'USD', tag)
        const sessionAmount = session === null ? undefined : pair(session.rub, session.usd)
        const projectAmount = project === null ? undefined : pair(project.rub, project.usd)

        // Left edge: this answer. Right edge: the Session and the whole project.
        const leftParts = []
        if (rubText === undefined) {
          leftParts.push(t('badgeTokens', { tokens: formatTokens(countOr(usage.totalTokens, 0), tag) }))
        } else {
          const leadingText = settings.currency === 'USD' ? usdText : rubText
          const bounded = leadingText.startsWith('<')
          const answerAmount = settings.currency === 'USD'
            ? usdText
            : rubText + ' / ' + usdText
          leftParts.push(bounded
            ? t('bound', { amount: answerAmount.replace(/^<\s*/, '') })
            : t('approx', { amount: answerAmount }))
        }
        const rightParts = []
        if (sessionAmount !== undefined) rightParts.push(t('sessionInline', { amount: sessionAmount }))
        if (projectAmount !== undefined) rightParts.push(t('projectInline', { amount: projectAmount }))
        const leftText = leftParts.join(' · ')
        const rightText = rightParts.join(' · ')

        const rows = []
        const row = (label, value) => {
          rows.push(h('dt', { key: 'dt:' + label }, label), h('dd', { key: 'dd:' + label }, value))
        }
        const routeText = priced !== null
          ? priced.key
          : singleRoute !== undefined
            ? singleRoute
            : routes.length > 1
              ? t('severalModels')
              : t('unknownRoute')
        row(t('model'), routeText)
        row(t('input'), formatExactTokens(countOr(usage.uncachedInputTokens, 0), tag))
        if (usage.cacheReadTokens !== undefined) row(t('cacheRead'), formatExactTokens(usage.cacheReadTokens, tag))
        if (usage.cacheWriteTokens !== undefined) row(t('cacheWrite'), formatExactTokens(usage.cacheWriteTokens, tag))
        row(t('output'), formatExactTokens(countOr(usage.outputTokens, 0), tag))
        row(t('totalTokens'), formatExactTokens(countOr(usage.totalTokens, 0), tag))
        if (priced !== null && settings.currency !== 'USD') row(t('inUsd'), formatCost(priced.amount, 'USD', tag))
        if (sessionAmount !== undefined) row(t('sessionRow'), sessionAmount)
        if (projectAmount !== undefined) row(t('projectRow'), projectAmount)
        if (turn.steps !== undefined && turn.steps !== null) row(t('steps'), String(turn.steps.length))

        const notes = []
        if (priced !== null) {
          notes.push(h('p', { key: 'prices', className: 'answer-cost-note' }, t('prices', {
            input: formatPrice(priced.price.input, tag),
            cacheRead: formatPrice(priced.price.cacheRead, tag),
            cacheWrite: formatPrice(priced.price.cacheWrite, tag),
            output: formatPrice(priced.price.output, tag),
          })))
          if (settings.currency !== 'USD') {
            if (answerRate.pinned) {
              notes.push(h('p', { key: 'rateTopUp', className: 'answer-cost-note' }, t('rateTopUp', {
                date: formatInstant(answerRate.at, tag),
                rate: formatRate(answerRate.rate, settings.currency, tag),
              })))
            } else {
              notes.push(h('p', { key: 'rateFixed', className: 'answer-cost-note' }, t('rateFixed', {
                rate: formatRate(answerRate.rate, settings.currency, tag),
              })))
            }
            notes.push(h('p', { key: 'rateByTopUp', className: 'answer-cost-note' }, t('rateByTopUp')))
          }
        } else if (routes.length > 1) {
          notes.push(h('p', { key: 'multiRoute', className: 'answer-cost-note' }, t('multiRoute', { count: String(routes.length) })))
        } else if (singleRoute !== undefined) {
          notes.push(h('p', { key: 'unpriced', className: 'answer-cost-note' }, t('unpriced', { route: singleRoute })))
        } else {
          notes.push(h('p', { key: 'noRoute', className: 'answer-cost-note' }, t('noRoute')))
        }
        if (session !== null) {
          notes.push(h('p', { key: 'sessionNote', className: 'answer-cost-note' }, t('sessionNote')))
          if (session.unpricedRoutes > 0) {
            notes.push(h('p', { key: 'sessionPartial', className: 'answer-cost-note' }, t('sessionPartial')))
          }
        }
        if (project !== null) {
          notes.push(h('p', { key: 'projectNote', className: 'answer-cost-note' }, t('projectNote', { count: String(project.sessions) })))
          if (project.skipped > 0) {
            notes.push(h('p', { key: 'projectPartial', className: 'answer-cost-note' }, t('projectPartial', { count: String(project.skipped) })))
          }
        }
        notes.push(h('p', { key: 'estimate', className: 'answer-cost-note' }, t('estimate')))

        return h('div', { className: 'answer-cost-root', ref: rootRef },
          h('span', { key: 'hint', className: 'answer-cost-visually-hidden', id: hintId }, t('hint')),
          h('button', {
            type: 'button',
            className: 'answer-cost-trigger',
            title: t('hint'),
            'aria-describedby': hintId,
            'aria-expanded': open,
            'aria-controls': open ? panelId : undefined,
            onClick: () => { setOpen(value => !value) },
          },
            h('span', { className: 'answer-cost-side' },
              h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
                h('circle', { cx: 8, cy: 8, r: 6.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
                h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }),
              ),
              h('span', { className: 'answer-cost-label' }, leftText),
            ),
            rightText === '' ? null : h('span', { className: 'answer-cost-side answer-cost-side-right' },
              h('span', { className: 'answer-cost-label' }, rightText),
            ),
          ),
          open && h('div', {
            className: 'answer-cost-panel',
            id: panelId,
            role: 'group',
            'aria-label': t('title'),
          },
            h('div', { className: 'answer-cost-title' },
              h('span', null, t('title')),
              priced === null ? null : h('span', { className: 'answer-cost-amount' }, settings.currency === 'USD' ? usdText : rubText),
            ),
            h('dl', { className: 'answer-cost-details' }, rows),
            notes,
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx, config) {
        const settings = normalizeConfig(config)
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'answer-cost: dictionaries')
        ctx.effect(() => installStyles(), 'answer-cost: stylesheet')
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: '@local/answer-cost',
          order: 4,
          locale: NS,
        }, createAnswerCost(settings, ctx.locale)))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'answer-cost-balance',
          order: 2,
          locale: NS,
        }, createBalancePill(settings, ctx.locale)))
      },
    }
  },
})
