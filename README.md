# Answer cost

Shows what an answer cost, what the Session has cost so far, and what the whole
project has cost, in one line under every completed reply in Chat. Provider
prices are in US dollars; the rouble figure uses the rate pinned at your last
balance top-up, so a top-up re-prices future requests without rewriting the old
ones.

```
≈ 0,56 ₽ / $0.0066                    сессия 11,02 ₽ / $0.135 · проект 3,24 ₽ / $0.0390
```

Next to the turn and context pills under the composer, a balance pill shows what
is left on the account — dollars and roubles at the pinned top-up rate, for
example `$1.76 / 150,63 ₽`. It appears only when the account wallet is readable
and disappears for an API-key route or before the first balance read.

The left edge is this answer; the right edge is the Session and the project
(every Session whose working directory is the same folder). Clicking the line
floats the token breakdown above it: the model route, input tokens billed without
a cache hit, cached input, cache writes when the provider reports them, output
tokens, the Turn's total, the number of steps, the answer in US dollars, the
Session and project totals, the prices applied, and the top-up whose rate was
used. Escape or a press anywhere else closes it; the reply and its action row
never move.

## Rouble rate and top-ups

The account is topped up in roubles for dollars, so the rate that matters is the
one in force at the top-up, not a rate fetched for every message:

- The Host half watches the account wallet balance. When it grows, that is a
  top-up: the CBR rate of that day is fetched online and **pinned** as a new rate
  period.
- Every request is priced with the period that was in force when it ran. A new
  top-up starts a new period and therefore re-prices **future** requests only;
  answers from earlier periods keep their rouble figure.
- Request buckets before the first detected top-up use the packaged fallback
  rate from `config.rate` (82.1911, the CBR rate for 21.11.2026).
- The pinned periods and the last seen balance are cached in
  `%USERPROFILE%\.dsh\answer-cost\rates.json`, so a restart keeps them and can
  still notice a top-up that happened while the app was closed.
- The CBR series is fetched once at startup and every six hours; the wallet is
  checked at startup and every five minutes. Both are host-side requests, and
  the plugin sends nothing about your conversations.

The ruble amount actually paid in a top-up is not exposed by the account API, so
the pinned rate is the CBR market rate of the top-up day, not the exact
purchase rate.

## Prices

Prices are per 1M tokens in USD, keyed either `provider/model` for one exact
route or `*/model` for every route serving that model:

| Key | Input (cache miss) | Cached input | Cache write | Output |
| --- | --- | --- | --- | --- |
| `*/deepseek-flash` | 0.3 | 0.006 | 0.3 | 1.2 |
| `*/deepseek-v4-pro` | 1.32 | 0.044 | 1.32 | 3.96 |

These are DeepSeek's peak rates. An exact `provider/model` entry wins over the
wildcard field by field. A route without a price shows token usage instead of a
cost, and the panel says so; such routes are excluded from both totals. Set
`currency: USD` to show dollars only and skip the conversion.

```yaml
- id: answer-cost
  config:
    currency: RUB
    rate: 82.1911          # fallback before the first detected top-up
    prices:
      '*/deepseek-flash': { input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6 }
      'openrouter/deepseek-v4-pro': { input: 0.19, cacheRead: 0.19, cacheWrite: 0.19, output: 3.5 }
```

Quote a wildcard key: in YAML a leading `*` otherwise begins an alias.

## Where the configuration lives

The bundle's own patch carries the defaults. To change them without touching the
installed package, override the row in the profile patch —
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` — with the same `id`. A
matching override replaces the row's whole `config`, so repeat the fields you
want to keep.

## Limits

- A top-up is inferred from wallet growth: the account API exposes balances, not
  a transaction history. Two top-ups between two checks merge into one period and
  get the rate of the later check.
- The rate is pinned for the day of detection, not the exact minute of the
  payment; the CBR rate is a daily figure anyway.
- Without a readable wallet (an API-key route instead of the signed-in account)
  no top-up is ever detected and the fallback rate is used.
- A route without a price is excluded from the answer, Session and project
  totals, and the panel says when a total is partial.
- History inherited from a fork is skipped, so the project never bills the
  parent's tokens twice.

Turning the plugin off in **Plugins** removes the line; nothing else changes.
