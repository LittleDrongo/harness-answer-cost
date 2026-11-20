# Answer cost

Shows what each answer cost and what the whole session has cost so far, in one
line under every completed reply in Chat. Prices come from the provider in US
dollars; the amounts are also shown in roubles (or any configured currency) at a
rate you control.

```
≈ 0,54 ₽ / $0.0066 · сессия 7,87 ₽ / $0.0960
```

Clicking the line floats the token breakdown above it, over the reply — the
model route, input tokens billed without a cache hit, cached input, cache writes
when the provider reports them, output tokens, the Turn's total, the number of
steps, the answer in US dollars, the session total, and the per-1M prices and
rate that were applied. Escape or a press anywhere else closes it; the reply and
its action row never move.

## Where the numbers come from

- **The answer** reads the exact per-Turn token accounting the Chat layer already
  derives from the Session log — the same provider-reported usage the built-in
  "Turn usage" details show.
- **The session total** comes from a Host projection that folds the same usage
  samples across the whole Session log, grouped by model route, so the total is
  not limited to the transcript pages loaded in the browser. Retried attempts
  count, and an attempt that settles without a message is attributed to the
  route of the closest preceding message.

The plugin adds no request, no prompt text and no Session event; it only
multiplies reported token buckets by the configured prices and rate. The values
are therefore an estimate of the token bill, not an invoice: they cannot see
provider discounts, off-peak windows, subscriptions, or rounding the provider
applies.

## Prices and the rouble rate

Prices are per 1M tokens in USD, keyed either `provider/model` for one exact
route or `*/model` for every route serving that model. The packaged defaults use
the wildcard form, because the same model is reached through `deepseek-account`
(the signed-in account route this desktop profile uses) and `deepseek-official`
(an API key):

| Key | Input (cache miss) | Cached input | Cache write | Output |
| --- | --- | --- | --- | --- |
| `*/deepseek-flash` | 0.3 | 0.006 | 0.3 | 1.2 |
| `*/deepseek-v4-pro` | 1.32 | 0.044 | 1.32 | 3.96 |

These are DeepSeek's peak rates, so an off-peak bill is lower rather than
higher. `currency` names the display currency and `rate` is how many units of it
one US dollar buys; the packaged pair is `RUB` at 81.929, the Central Bank of
Russia rate for 20.11.2026. Neither is fetched at runtime — the plugin makes no
network request — so the rate is only as fresh as this configuration.

```yaml
- id: answer-cost
  config:
    currency: RUB
    rate: 81.929
    prices:
      '*/deepseek-flash': { input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6 }
      'openrouter/deepseek-v4-pro': { input: 0.19, cacheRead: 0.19, cacheWrite: 0.19, output: 3.5 }
```

Set `currency: USD` to see dollars only and skip the conversion. An exact
`provider/model` entry wins over the wildcard field by field: the fields it omits
come from the wildcard for the same model. A model with neither an exact nor a
wildcard entry, or an entry whose four values are all zero, shows token usage
instead of a cost and the opened panel says so; such routes are also excluded
from the session total, which the panel reports. Several routes inside one Turn
show tokens only, because the Turn aggregates cannot be split across routes
without guessing — the session total is unaffected because the Host groups usage
per route.

Quote a wildcard key: in YAML a leading `*` otherwise begins an alias.

## Where the rate lives after installation

The bundle's own default patch carries `currency` and `rate`. To change them
without touching the installed package, override the row in the profile patch —
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` — with the same `id` and
only the fields you want to change:

```yaml
- id: answer-cost
  config:
    currency: RUB
    rate: 92.5
```

A matching override replaces the row's whole `config`, so repeat the `prices`
block there as well if you keep custom prices.

## Limits

- The line appears only for a Turn whose usage the Chat layer could prove from
  the loaded log; with `turn/start` outside the loaded history window and for
  interrupted Turns, nothing is shown.
- The answer figure prices the whole Turn: every model attempt that produced the
  reply, including tool-call steps.
- The session total is the same arithmetic over the whole log, grouped by route;
  a route without a price is excluded and the panel says the total is partial.
- Numbers are only as accurate as the prices and rate in the configuration, and
  the rate is not updated automatically.

Turning the plugin off in **Plugins** removes the line; nothing else changes.
