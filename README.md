# tiny-sol-bot

A paper-trading bot for hourly Solana bars (FARTCOIN, JITOSOL, POPCAT, RAY, SOL,
WETH, WIF) — entry for `u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1` on make.fun.
Long only, no leverage, no shorts. The strategy is built to be robust on the final
window (3 whole UTC days collected after the deadline), not fitted to the dev window.

## Strategy (see `strategy.ts`)

One signal, a momentum-dip scalp:

- **Entry** — MACD(12, 26, 9) above its signal line (momentum rising) while
  CCI(14) is at or under −40 (the bar is washed out). A level signal, re-read
  every bar.
- **Exits (narrow on purpose)** — take-profit +2%, a wide −15% tail stop, or
  stale (36+ bars old and still under +1%). No other exits: earlier variants
  showed extra exits only churn positions before the bounce arrives.

Sizing: base stake is equity / 5 (at most 5 concurrent positions), scaled by
`clamp(3% / ATR%, 0.6, 1.4)` where ATR% is the 14-bar mean true range over the
close — wild memes get smaller stakes, calm majors larger ones. Scalps take
60% of that. A drawdown brake halves stakes 10% under peak equity and stops
new entries 15% under it (the guardrail is 25%). All decisions are
deterministic float64 on the bars alone: no clock, no randomness, so two runs
produce byte-identical orders.

Two tested-and-rejected legs stay in `strategy.ts`, switched off by flags for
later re-testing: a trend leg (EMA(8)/EMA(21) cross-up) and an RSI-dip leg
(RSI(14) under 32 below the lower Bollinger band).

## Layout

- `main.ts` — wires the strategy through the SDK.
- `strategy.ts` — indicators, signals, sizing, exits.
- `vendor/makefun-bars.ts` — the kit's SDK, vendored unchanged.

## Local grade (dev window)

Run from the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <path to this repo> --driver process
```

Dev-window results (see `BUILD.md` for the full variant table):

| bot | net PnL (USDC) | trades | max drawdown |
| --- | --- | --- | --- |
| buy-and-hold | −869.34 | 7 | 10.9% |
| ema-cross | −173.04 | 28 | 2.5% |
| momentum | −268.23 | 19 | 5.7% |
| rsi-bollinger | −56.49 | 8 | 5.2% |
| adx-momentum | −114.42 | 11 | 1.4% |
| macd-cci | −20.22 | 17 | 2.5% |
| **tiny-sol-bot (v5, final)** | **+41.36** | **21** | **3.1%** |

## License

MIT — see `LICENSE`.
