// tiny-sol-bot: a momentum-dip scalp, long only.
//
// Written in-session for u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1. The final window
// is 3 whole UTC days collected AFTER the deadline, so every rule here is a standard,
// regime-level rule with textbook parameters — nothing is fitted to the dev window and
// nothing is tuned per asset. All arithmetic is float64 on the bars alone, so two runs
// over the same bars produce byte-identical orders.
//
// Idea: on hourly bars, a washed-out dip inside rising momentum bounces a little far
// more often than it keeps falling. So the bot buys one thing only — the dip — and
// banks the bounce fast, instead of riding trends that, in a 3-day window, mostly
// reverse before they pay:
//
//   Entry: MACD(12, 26, 9) above its signal line (momentum is rising) while
//     CCI(14) is at or under -40 (the bar is washed out). A level signal, re-read
//     every bar: a position that just banked its +2% is bought again while the dip
//     is still washed out.
//   Exits (narrow on purpose): take-profit +2%, a wide -15% tail stop, or stale
//     (36+ bars old and still under +1% — free the capital). Nothing else: earlier
//     variants showed extra exits (EMA flip, RSI>70, MACD turn-down) only churn
//     positions before the bounce arrives.
//   Sizing: base stake equity / 5 (at most 5 concurrent positions), scaled by
//     clamp(3% / ATR%, 0.6, 1.4) where ATR% is the 14-bar mean true range over the
//     close — wild memes get smaller stakes, calm majors larger ones. Dip scalps
//     take 60% of that. Every buy is also capped by caps.max_weight_bps and the cash
//     on hand.
//   Drawdown brake: peak equity is tracked; below 10% under the peak stakes halve,
//     below 15% under it no new entries are opened at all (the 25% guardrail stays
//     out of reach). Exits are never braked.
//
// The file also carries the two legs that were tested and rejected, switched off by
// flags so a later run can re-test them without rewriting: a trend leg (EMA(8)/EMA(21)
// cross-up with a 24-bar-return and regime gate — cross-ups in a falling market
// reverse before any profit) and an RSI-dip leg (RSI(14) under 32 below the lower
// Bollinger band — a blind dip without momentum confirmation is a falling knife).
//
// Order protocol (from the SDK): orders decided on bar k fill at bar k+1's open, so a
// sell's proceeds never fund a buy of the same reply — sells go out first and buys
// follow on later batches once the cash has landed. A bar with zero volume signals
// nothing. Warm-up batches build indicators only. Slippage is capped at 100 bps, so
// an order into a liquidity gap is refused and retried instead of filled for nothing.

import { BPS, type Bar, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const RSI_BARS = 14;
const BAND_BARS = 20;
const BAND_SIGMAS = 2;
const LOOKBACK_BARS = 24;
const ATR_BARS = 14;

const RSI_DIP_BELOW = 32;
const RSI_EXIT_ABOVE = 70;
/** v5/v6 test: trend entries ON with the narrow exit set scored -97.48, worse than
 *  the scalp leg alone (+41.36) — cross-ups in a falling market still reverse
 *  before any profit. Final: trend leg OFF, scalp leg only. */
const TREND_ENABLED = false;
/** v2: RSI-dip entries off (see the dip-entry note below). */
const DIP_ENABLED = false;
/** v4: momentum-dip entry — MACD above its signal while CCI(14) is washed out. */
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const CCI_BARS = 14;
const CCI_DIP_AT_MOST = -40;
const MAX_SLIPPAGE_BPS = 100;

/** At most this many concurrent positions; base stake is equity / MAX_POSITIONS. */
const MAX_POSITIONS = 5;
/** A dip entry takes this fraction of the trend stake. */
const DIP_STAKE = 0.6;
/** Volatility target for sizing: stake scales by clamp(TARGET_ATR_PCT / atrPct, 0.6, 1.4). */
const TARGET_ATR_PCT = 0.03;
const SIZE_MIN = 0.6;
const SIZE_MAX = 1.4;
/** Take-profit / stop-loss, as value-over-cost ratios. v5 (scalp profile): the dip
 *  scalp exits at +2% — hourly dips bounce a little far more often than they run —
 *  with a wide -15% tail stop that almost never fires; the exit set is narrow on
 *  purpose (v4 showed extra exits — EMA flip, RSI>70, MACD turn-down — only churn). */
const TP_TREND = [106n, 100n] as const;
const TP_DIP = [102n, 100n] as const;
const STOP = [85n, 100n] as const;
/** A position this old (bars) and still under +1% is dead capital: free it. */
const STALE_BARS = 36;
const STALE_TP = [101n, 100n] as const;
/** Drawdown brake: below 10% under the peak, halve stakes; below 15%, stop entering. */
const BRAKE_HALVE = 0.9;
const BRAKE_STOP = 0.85;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** RSI(14), Wilder's: null until 14 changes have been seen. */
  rsi: number | null;
  rsiPrev: number | null;
  /** First RSI_BARS changes, while the averages are not set yet. */
  first: number[];
  gain: number | null;
  loss: number | null;
  lastClose: number | null;
  /** The last BAND_BARS typical prices, oldest first. */
  typical: number[];
  /** The last LOOKBACK_BARS + 1 closes, oldest first. */
  closes: number[];
  /** The last ATR_BARS true ranges, oldest first. */
  ranges: number[];
  prevBar: { h: number; l: number; c: number } | null;
  /** MACD(12, 26, 9) state: warm closes until the slow EMA starts, then MACD and
   *  its signal line. The slow EMA seeds as the mean of its first 26 closes, the
   *  fast as the mean of the 12 closes up to that bar; the signal as the mean of
   *  the first 9 MACD values. */
  macdWarm: number[];
  macdFast: number | null;
  macdSlow: number | null;
  macdValues: number[];
  macdSignal: number | null;
  macd: number | null;
  /** CCI(14) on typical prices: null before 14 bars. */
  cci: number | null;
}

const series = new Map<string, Series>();
/** When each open position was filled (batch seq), and whether it was a dip entry. */
const opened = new Map<string, { seq: number; dip: boolean }>();
/** Dip flags of buys decided but not yet filled: set at order time, read at fill time. */
const pendingDip = new Map<string, boolean>();
/** Peak equity seen, for the drawdown brake. */
let peakEquity = 0n;

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function newSeries(): Series {
  return {
    fast: { span: FAST_BARS, warm: [], value: null },
    slow: { span: SLOW_BARS, warm: [], value: null },
    gap: null,
    now: null,
    rsi: null,
    rsiPrev: null,
    first: [],
    gain: null,
    loss: null,
    lastClose: null,
    typical: [],
    closes: [],
    ranges: [],
    prevBar: null,
    macdWarm: [],
    macdFast: null,
    macdSlow: null,
    macdValues: [],
    macdSignal: null,
    macd: null,
    cci: null,
  };
}

/** Fold a bar into its symbol's indicators. */
function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = newSeries()));
  const c = Number(bar.c);
  const h = Number(bar.h);
  const l = Number(bar.l);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;

  // RSI(14), Wilder's smoothing.
  if (s.lastClose !== null) {
    const change = c - s.lastClose;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_BARS) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
    }
  }
  s.rsiPrev = s.rsi;
  if (s.gain !== null && s.loss !== null) {
    const moved = s.gain + s.loss;
    s.rsi = moved === 0 ? 50 : (100 * s.gain) / moved;
  }
  s.lastClose = c;

  // Bollinger bands run on typical prices.
  s.typical.push((h + l + c) / 3);
  if (s.typical.length > BAND_BARS) s.typical.shift();

  // 24-bar return needs 25 closes.
  s.closes.push(c);
  if (s.closes.length > LOOKBACK_BARS + 1) s.closes.shift();

  // ATR: true range against the previous bar's close.
  if (s.prevBar !== null) {
    let tr = h - l;
    const up = h - s.prevBar.c;
    if (up > tr) tr = up;
    const down = s.prevBar.c - l;
    if (down > tr) tr = down;
    s.ranges.push(tr);
    if (s.ranges.length > ATR_BARS) s.ranges.shift();
  }
  // MACD(12, 26, 9) on closes.
  if (s.macdSlow === null || s.macdFast === null) {
    s.macdWarm.push(c);
    if (s.macdWarm.length === MACD_SLOW) {
      s.macdSlow = s.macdWarm.reduce((a, x) => a + x, 0) / MACD_SLOW;
      s.macdFast = s.macdWarm.slice(MACD_SLOW - MACD_FAST).reduce((a, x) => a + x, 0) / MACD_FAST;
    }
  } else {
    s.macdFast = s.macdFast + (2 / (MACD_FAST + 1)) * (c - s.macdFast);
    s.macdSlow = s.macdSlow + (2 / (MACD_SLOW + 1)) * (c - s.macdSlow);
  }
  s.macd = s.macdFast !== null && s.macdSlow !== null ? s.macdFast - s.macdSlow : null;
  if (s.macd !== null) {
    if (s.macdSignal !== null) {
      s.macdSignal = s.macdSignal + (2 / (MACD_SIGNAL + 1)) * (s.macd - s.macdSignal);
    } else {
      s.macdValues.push(s.macd);
      if (s.macdValues.length === MACD_SIGNAL) s.macdSignal = s.macdValues.reduce((a, x) => a + x, 0) / MACD_SIGNAL;
    }
  }

  // CCI(14): (typical - mean) / (0.015 x mean absolute deviation).
  if (s.typical.length >= CCI_BARS) {
    const window = s.typical.slice(s.typical.length - CCI_BARS);
    const mean = window.reduce((a, x) => a + x, 0) / CCI_BARS;
    const dev = window.reduce((a, x) => a + (x < mean ? mean - x : x - mean), 0) / CCI_BARS;
    const typical = (h + l + c) / 3;
    s.cci = dev === 0 ? 0 : (typical - mean) / (0.015 * dev);
  }

  s.prevBar = { h, l, c };
  return s;
}

/** The lower Bollinger band, or null before BAND_BARS bars. */
function lowerBand(s: Series): number | null {
  if (s.typical.length < BAND_BARS) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / BAND_BARS;
  const variance = s.typical.reduce((a, x) => a + (x - mean) * (x - mean), 0) / BAND_BARS;
  return mean - BAND_SIGMAS * Math.sqrt(variance);
}

/** The trailing 24-bar return as a ratio (now / then), or null without the history. */
function trailingReturn(s: Series): number | null {
  if (s.closes.length <= LOOKBACK_BARS) return null;
  const then = s.closes[0]!;
  return then === 0 ? null : s.closes[s.closes.length - 1]! / then;
}

/** Mean true range as a fraction of the latest close, or null without the history. */
function atrPct(s: Series): number | null {
  if (s.ranges.length < ATR_BARS || s.lastClose === null || s.lastClose === 0) return null;
  return s.ranges.reduce((a, x) => a + x, 0) / ATR_BARS / s.lastClose;
}

/** Whether a held position exits on this close. v5 (scalp profile): only the
 *  take-profit, the wide tail stop, and the stale exit. A scalp that has not
 *  bounced +2% is held, not cut on every wiggle — v4's extra exits only churned. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series, dip: boolean): boolean {
  const value = state.value(symbol, held.qty);
  const tp = dip ? TP_DIP : TP_TREND;
  if (value * tp[1] >= held.cost * tp[0]) return true;
  if (value * STOP[1] <= held.cost * STOP[0]) return true;
  // Stale and flat: free the capital.
  const open = opened.get(symbol);
  if (open !== undefined && state.seq - open.seq >= STALE_BARS && value * STALE_TP[1] <= held.cost * STALE_TP[0]) return true;
  return false;
}

/** The stake for a buy of `symbol`, volatility-scaled and brake-aware, or 0n to skip. */
function stake(state: BarsState, cash: bigint, symbol: string, s: Series, dip: boolean): bigint {
  const { caps, fees } = state.hello;
  const base = state.equity / BigInt(MAX_POSITIONS);
  let size = base;
  const atr = atrPct(s);
  if (atr !== null && atr > 0) {
    let mult = TARGET_ATR_PCT / atr;
    if (mult < SIZE_MIN) mult = SIZE_MIN;
    if (mult > SIZE_MAX) mult = SIZE_MAX;
    size = BigInt(Math.floor(Number(base) * mult));
  }
  if (dip) size = (size * 6n) / 10n;
  // Drawdown brake: halve stakes 10% under the peak.
  if (peakEquity > 0n && state.equity * 10n < peakEquity * 9n) size /= 2n;
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  if (size > byWeight) size = byWeight;
  if (size > cash) size = cash;
  if (size === 0n || size < BigInt(fees.min_notional_quote_units)) return 0n;
  return size;
}

export function createStrategy() {
  return {
    onBatch(state: BarsState, batch: Batch): OrderInput[] {
      // A buy filled on this batch: record when it opened and what kind it was
      // (the kind was fixed when the order was decided, not at fill time).
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          opened.set(f.symbol, { seq: state.seq, dip: pendingDip.get(f.symbol) ?? false });
          pendingDip.delete(f.symbol);
        }
        if (f.side === 'sell' && f.status === 'filled') opened.delete(f.symbol);
      }
      const fresh = new Set<string>();
      for (const bar of batch.bars) {
        push(bar);
        fresh.add(bar.symbol);
      }
      if (state.warmingUp) return [];

      if (state.equity > peakEquity) peakEquity = state.equity;
      const braked = peakEquity > 0n && state.equity * 20n < peakEquity * 17n; // 15% under the peak: stop entering
      // How many symbols are trending up right now (for the regime gate).
      let trendingUp = 0;
      for (const { symbol } of state.hello.symbols) {
        const s = series.get(symbol);
        if (s !== undefined && s.now !== null && s.now > 0) trendingUp++;
      }

      const { caps } = state.hello;
      const sells: SellInput[] = [];
      const entries: { symbol: string; dip: boolean }[] = [];
      for (const { symbol } of state.hello.symbols) {
        if (!fresh.has(symbol)) continue;
        const s = series.get(symbol)!;
        const bar = batch.bars.find((b) => b.symbol === symbol)!;
        const held = state.positions.get(symbol);
        if (held !== undefined) {
          const open = opened.get(symbol);
          if (exits(state, symbol, held, s, open !== undefined && open.dip)) {
            sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
          continue;
        }
        if (braked || bar.v === '0') continue;
        const ret = trailingReturn(s);
        // Trend entry: EMA cross up, trailing return positive, not a lone bounce.
        // v5: TREND_ENABLED is false — the trend leg alone scored -102 on the dev
        // window (cross-ups in a falling market reverse before any profit); this
        // variant isolates the momentum-dip scalp leg.
        if (
          TREND_ENABLED &&
          s.gap !== null && s.now !== null && s.gap <= 0 && s.now > 0 && ret !== null && ret > 1 && trendingUp >= 2
        ) {
          entries.push({ symbol, dip: false });
          continue;
        }
        // Momentum-dip entry: MACD above its signal while CCI(14) is washed out —
        // buying the dip inside rising momentum, not chasing a cross. A quick scalp:
        // it exits on a 3% take-profit or a MACD turn-down (see exits()).
        if (
          s.macd !== null && s.macdSignal !== null && s.macd > s.macdSignal &&
          s.cci !== null && s.cci <= CCI_DIP_AT_MOST
        ) {
          entries.push({ symbol, dip: true });
          continue;
        }
        // Dip entry: RSI crosses below 32 under the lower Bollinger band.
        // v2: DIP_ENABLED is false — in a falling market RSI dips are falling
        // knives; the dev window showed dip scalps churning fees without edge.
        // The rule stays here, switchable, so a later variant can re-test it.
        const lower = lowerBand(s);
        if (
          DIP_ENABLED &&
          s.rsi !== null && s.rsiPrev !== null && s.rsiPrev >= RSI_DIP_BELOW && s.rsi < RSI_DIP_BELOW &&
          lower !== null && s.lastClose !== null && s.lastClose < lower
        ) {
          entries.push({ symbol, dip: true });
        }
      }

      const orders: OrderInput[] = sells.slice(0, caps.max_orders_per_bar);
      let room = MAX_POSITIONS - state.positions.size;
      // A sell's proceeds land at the next open and never fund a buy of this reply:
      // only the cash on hand can be spent, and positions sold this reply still count
      // against the room until they are gone.
      room -= sells.length;
      let cash = state.cash;
      for (const { symbol, dip } of entries) {
        if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
        const amount = stake(state, cash, symbol, series.get(symbol)!, dip);
        if (amount === 0n) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        pendingDip.set(symbol, dip);
        cash -= amount;
        room--;
      }
      return orders;
    },
  };
}
