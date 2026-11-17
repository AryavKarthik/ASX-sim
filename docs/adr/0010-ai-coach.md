# 10. The AI coach teaches and reviews; it never tips

- **Status:** accepted
- **Date:** 2026-11-17

## Context

ASX-sim exists to teach its owner to trade. An AI assistant can explain what is on screen,
question a plan and review a journal far faster than reading alone. It could also do harm in
two ways: by handing out buy and sell calls (which teaches nothing and can't be done
reliably), and, in a replayed session, by using knowledge of what happened next.

The owner set the constraints: the Claude API, a key kept in environment variables, about
US$10 a month, a cheap model for chat and a stronger one for deep reviews.

## Decision

**Two kinds of request, two models.**

| Request | Model | Why |
|---|---|---|
| Chat: a question plus the recent conversation | Claude Haiku 5.5, low effort | Fast and very cheap; most questions are explanations |
| Full review of journal and statistics | Claude Sonnet 5.5, medium effort | Worth more reasoning; used a few times a week |

Both models are settings (`COACH_CHAT_MODEL`, `COACH_REVIEW_MODEL`).

**A coach, not a tipster.** The system prompt explains the role and the reason for the line:
the coach teaches mechanics, chart reading, process and psychology, points out flaws in a
plan, and describes what the data shows. It does not say buy, sell or hold, and does not
predict prices. A test pins those sentences so they can't be dropped by accident.

**It sees only what the simulator knows right now.** Each request carries a snapshot built
by the live hub: account, positions, open orders, the 20 most recent trades with journal
notes, performance statistics, and the watched stock's quote and session so far. The hub
never holds data past the market clock (delayed in live mode, replayed in a demo), so the
snapshot can't contain the future. The prompt also tells the model to treat the snapshot's
`market_time` as "now" and not to use anything it may know about later events.

**The browser is untrusted.** The conversation is kept in the browser and sent back with
each question. The server keeps only well-formed, alternating user and assistant turns, caps
their number and length, and drops anything else, so a "system" turn can't be smuggled in.

**Spend is capped.** Every reply's token counts are costed at list prices and added to a
monthly ledger saved beside the simulated account. Once the month's total reaches
`COACH_MONTHLY_BUDGET_USD` the coach refuses new requests. An unlisted model is costed at
the dearest known rate. The spend limit in the Anthropic console remains the hard backstop;
the ledger is an estimate.

**The key never leaves the machine.** It is read from `.env` (gitignored) into the
environment, where the SDK picks it up. Without a key the coach is switched off and the app
shows setup steps. `COACH_PRACTICE=1` streams a canned, clearly labelled reply for trying
the screen without a key.

**Replies stream** over the existing WebSocket, one request at a time per connection. The
system prompt is constant and marked cacheable; the changing snapshot comes after it.

**Refusals.** On Sonnet the request opts into server-side fallbacks, so a declined request
is retried on another model inside the same call. Haiku has no such fallback: a refusal is
shown as a short message asking the learner to rephrase.

## Consequences

- The model call sits behind a small `Backend` protocol, so the whole coach is tested with a
  stand-in and CI never needs a key or the network.
- The path through the real SDK has been type-checked against the SDK but not yet run with a
  real key; the first real request is the remaining check.
- Chat costs fractions of a cent per question. A full review sends the whole snapshot to the
  stronger model and costs a few cents.
- The system prompt is short, so it may fall below the minimum cacheable size; caching then
  simply doesn't apply.
- The coach has no tools and cannot place orders. That is deliberate.
