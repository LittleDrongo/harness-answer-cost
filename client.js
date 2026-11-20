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
    const DEFAULT_RATE = 81.929

    const CSS = `
.answer-cost-root {
  position: relative; display: flex; align-items: flex-start;
}
.answer-cost-trigger {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  margin-left: -6px; padding: 6px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
}
.answer-cost-trigger svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); flex: none; }
.answer-cost-trigger .answer-cost-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
        badge: '≈ {cost}',
        badgeBound: '< {cost}',
        badgeTokens: '{tokens} tok',
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
        rate: 'Converted at {rate} per 1 US dollar.',
        unpriced: 'No price is configured for {route}, so only token usage is shown.',
        severalModels: 'several models',
        multiRoute: 'This answer used {count} model routes, so only token usage is shown.',
        noRoute: 'This answer reports no model route, so only token usage is shown.',
        unknownRoute: 'not reported',
        estimate: 'Estimated from the plugin configuration. Defaults are peak-rate prices.',
      },
      ru: {
        badge: '≈ {cost}',
        badgeBound: '< {cost}',
        badgeTokens: 'токены: {tokens}',
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
        rate: 'Курс пересчёта: {rate} за 1 доллар США.',
        unpriced: 'Для {route} цена не задана — показан только расход токенов.',
        severalModels: 'несколько моделей',
        multiRoute: 'В ответе участвовало несколько моделей ({count}), поэтому показан только расход токенов.',
        noRoute: 'В ответе не указана модель, поэтому показан только расход токенов.',
        unknownRoute: 'не указана',
        estimate: 'Оценка по ценам из настроек плагина. По умолчанию — пиковые тарифы.',
      },
      zh: {
        badge: '≈ {cost}',
        badgeBound: '< {cost}',
        badgeTokens: '{tokens} 令牌',
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
        rate: '按 1 美元 = {rate} 换算。',
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
     * Resolve the price for one exact route: an exact `provider/model` entry
     * wins, then the wildcard entry that prices every provider serving that
     * model, then nothing.
     */
    function resolvePrice(prices, route) {
      const key = routeKeyOf(route)
      if (key === undefined) return null
      if (Object.prototype.hasOwnProperty.call(prices, key)) return { key, price: prices[key] }
      const wildcard = '*/' + route.model
      if (Object.prototype.hasOwnProperty.call(prices, wildcard)) return { key, price: prices[wildcard] }
      return null
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
      if (price.input === 0 && price.cacheRead === 0 && price.cacheWrite === 0 && price.output === 0) return null
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
     * Build the slot entry bound to one normalized configuration.
     * @param settings - display currency, its rate per USD, and per-route prices.
     * @param locale - the Client locale service, read for number formatting.
     * @returns the React entry for `conversation.chat.turnTail`.
     */
    function createAnswerCost(settings, locale) {
      return function AnswerCost({ turn, t }) {
        const [open, setOpen] = React.useState(false)
        const rootRef = React.useRef(null)
        const panelId = React.useId()
        const hintId = React.useId()

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
        // Provider prices are USD; the rate converts them for display only.
        const displayAmount = priced === null ? null : priced.amount * settings.rate
        // A bounded amount replaces the approximate sign: "less than $0.0001"
        // must not read as "approximately less than".
        const costText = displayAmount === null ? undefined : formatCost(displayAmount, settings.currency, tag)
        const label = costText === undefined
          ? t('badgeTokens', { tokens: formatTokens(countOr(usage.totalTokens, 0), tag) })
          : costText.startsWith('<')
            ? t('badgeBound', { cost: costText.replace(/^<\s*/, '') })
            : t('badge', { cost: costText })

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
            notes.push(h('p', { key: 'rate', className: 'answer-cost-note' }, t('rate', {
              rate: formatRate(settings.rate, settings.currency, tag),
            })))
          }
        } else if (routes.length > 1) {
          notes.push(h('p', { key: 'multiRoute', className: 'answer-cost-note' }, t('multiRoute', { count: String(routes.length) })))
        } else if (singleRoute !== undefined) {
          notes.push(h('p', { key: 'unpriced', className: 'answer-cost-note' }, t('unpriced', { route: singleRoute })))
        } else {
          notes.push(h('p', { key: 'noRoute', className: 'answer-cost-note' }, t('noRoute')))
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
            h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
              h('circle', { cx: 8, cy: 8, r: 6.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
              h('circle', { cx: 8, cy: 8, r: 2.6, fill: 'currentColor' }),
            ),
            h('span', { className: 'answer-cost-label' }, label),
          ),
          open && h('div', {
            className: 'answer-cost-panel',
            id: panelId,
            role: 'group',
            'aria-label': t('title'),
          },
            h('div', { className: 'answer-cost-title' },
              h('span', null, t('title')),
              priced === null ? null : h('span', { className: 'answer-cost-amount' }, formatCost(displayAmount, settings.currency, tag)),
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
      },
    }
  },
})
