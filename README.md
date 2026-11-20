# Answer cost

Shows the estimated cost of an answer under that answer in Chat, so a session's
spend is visible without leaving the conversation. Prices come from the provider
in US dollars; the amount is shown in roubles (or any configured currency) at a
rate you control.

Under every completed reply there is a small muted pill, for example `≈ 0,54 ₽`.
Clicking it floats the token breakdown above the pill, over the reply — the model
route, input tokens billed without a cache hit, cached input, cache writes when
the provider reports them, output tokens, the Turn's total, the number of steps,
the amount in US dollars, and the per-1M prices and rate that were applied.
Escape or a press anywhere else closes it, and the reply and its action row never
move.

## Where the numbers come from

The pill reads the exact per-Turn token accounting that the Chat layer already
derives from the Session log — the same provider-reported usage the built-in
"Turn usage" details show. The plugin adds no request, no prompt text and no
Session event; it only multiplies the reported token buckets by the configured
prices and rate. The value is therefore an estimate of the token bill, not an
invoice: it cannot see provider discounts, off-peak windows, subscriptions, or
rounding the provider applies.

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

Set `currency: USD` to see dollars and skip the conversion entirely. An exact
`provider/model` entry wins over the wildcard field by field: the fields it omits
come from the wildcard for the same model, which is how a reseller's different
output rate is expressed without making its input free. A model with neither an
exact nor a wildcard entry, or an entry whose four values are all zero, shows
token usage instead of a cost and the opened panel says so. Several routes
inside one Turn also show tokens only, because the Turn aggregates cannot be
split across routes without guessing.

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

- The pill appears only for a Turn whose usage the Chat layer could prove from
  the loaded log; with `turn/start` outside the loaded history window and for
  interrupted Turns, nothing is shown.
- It prices the whole Turn: every model attempt that produced the reply,
  including tool-call steps. A reply that needed three model calls shows their
  combined cost.
- Numbers are only as accurate as the prices and rate in the configuration, and
  the rate is not updated automatically.

Turning the plugin off in **Plugins** removes the pill; nothing else changes.
