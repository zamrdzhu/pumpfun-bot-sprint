# pumpfun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/zamrdzhu/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/zamrdzhu/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading momentum scalper for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. One program, `main.ts` (Node 22, no dependencies), trading paper SOL on a replay of real pump.fun bonding-curve data. No real funds, no network, no secrets.

## Strategy

Momentum scalper, built fresh for this sprint and verified with the kit's local grader on the dev window:

- **Enter** only on accelerating buy pressure: a mature curve (1,200+ slots old, 25+ trades) whose price is up 18%+ over a 200-slot window, sitting within 3% of its window high, with 4+ buys from 3+ distinct wallets and 2+ SOL of net inflow — the newer half of the window inflowing at least as fast as the older.
- **Size small, pyramid into strength**: first buy 0.08 SOL, adds of 0.08 SOL only while the price keeps stepping up 5%+ on positive inflow, at most 0.32 SOL per coin.
- **Exit fast**: 12% stop loss, take-profit at +35%, a trailing stop that arms once up 6% and banks the move on a 10% pullback from the peak, a fade exit when inflow turns negative, and a 1,500-slot max hold.
- **Guardrails**: tiny 0.02 SOL probe round-trips keep the run above the 20-coin minimum when momentum entries fall behind pace.

Deterministic by construction: no clock, no randomness, no environment reads — every decision is a pure function of the replay events, so the harness's two executions produce byte-identical action logs.

## Files

- `main.ts` — the whole bot: replay wire protocol, state tracking, strategy.
- `.makefun/owner.json` — the payout wallet that claims this entry.

## Dev grade

`grade-local --driver process` on the kit dev window (128,058 events): **net PnL −1.127 SOL**, 532 fills over 53 coins, 196 round trips, win rate 0.199, max drawdown 0.121, guardrails met (53 coins with a ≥0.01 SOL round trip). Deterministic: the harness's two executions reproduce the action log byte for byte. Two nearby variants graded slightly worse (faster exits −1.168 SOL, stricter entry −1.156 SOL), so these parameters stand. The final window is a fresh 6-hour tape, so the dev number is a behaviour check, not a forecast.

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
