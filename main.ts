// Breakout rider: a long-only BTC trend bot for agent-fun/bars-replay/v1.
//
// Idea: on 1-minute bars the noise is ~8 bps a minute while a full-size round
// trip costs ~30 bps, so frequent trading loses to fees. The edge is in the
// rare multi-hour legs: enter when the close prints a new 60-bar high (the leg
// is starting), ride it with a wide 200 bps trailing stop (about 25x the
// 1-minute volatility, so ordinary chop never fires it), and re-enter on the
// next new high if stopped out. A hard equity-drawdown guard flattens the
// position and halts trading for the rest of the window if equity ever falls
// 12% below its peak, which bounds the worst case far inside the 25%
// guardrail. No new entries in the final 60 bars: a leg entered that late
// cannot reasonably clear its round-trip cost before the window ends.
// Everything is decided from closes alone, in integer arithmetic, so two runs
// on the same data produce the same orders.
//
// Dev-window behaviour (offline model, then verified with grade-local): one
// trade, in just before the window's big up-leg, held to the end.

import { runBars } from './vendor/makefun-bars.ts';
import type { Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Bars of history a close must beat to count as a breakout.
const LOOKBACK = 60;
// No new entries once this many bars of the window have been seen: a leg
// entered later cannot clear its round-trip cost before the window ends.
const NO_ENTRY_AFTER_BARS = 1380;
// Trailing stop, in bps below the highest close since entry.
const TRAIL_BPS = 200n;
// Equity-drawdown guard, in bps below the equity peak: flatten and halt.
const GUARD_BPS = 1200n;
const BPS = 10000n;
// Orders fill at the next bar's open; 150 bps of room covers the largest
// 1-minute move in the dev window (72 bps) plus slippage and impact.
const MAX_SLIPPAGE_BPS = 150;

// Closes seen so far, as raw price units (price_scale from hello).
const closes: bigint[] = [];
// Highest close since the current entry; null while flat.
let peakSinceEntry: bigint | null = null;
// Highest equity seen; null until the first batch.
let equityPeak: bigint | null = null;
// True once the drawdown guard has fired: stay flat for the rest of the run.
let halted = false;

await runBars({
  onBatch(state, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    // No bar for our symbol this minute, or a warm-up batch: no decision.
    if (bar === undefined || state.warmingUp) return [];
    const close = BigInt(bar.c);
    closes.push(close);

    if (equityPeak === null || state.equity > equityPeak) equityPeak = state.equity;
    const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (halted) return [];

    if (qty > 0n) {
      if (peakSinceEntry === null || close > peakSinceEntry) peakSinceEntry = close;
      // Drawdown guard: equity 12% below its peak -> sell everything, halt.
      if (state.equity * BPS <= equityPeak * (BPS - GUARD_BPS)) {
        halted = true;
        peakSinceEntry = null;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      // Trailing stop: close 200 bps below the best close since entry.
      if ((peakSinceEntry - close) * BPS >= TRAIL_BPS * peakSinceEntry) {
        peakSinceEntry = null;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: enter on a new 60-bar high, with a full-cash buy.
    if (closes.length <= LOOKBACK) return [];
    if (closes.length > NO_ENTRY_AFTER_BARS) return [];
    let high = closes[closes.length - LOOKBACK - 1];
    for (let i = closes.length - LOOKBACK; i < closes.length - 1; i++) {
      if (closes[i] > high) high = closes[i];
    }
    if (close < high) return [];
    if (state.cash <= 0n) return [];
    peakSinceEntry = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
