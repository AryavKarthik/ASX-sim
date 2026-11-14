# 1. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-11-14

## Context

Many choices in this project are trade-offs. Examples: which database, how fills are
modelled, how data is licensed. Months later it's easy to forget *why* a choice was made,
and that "why" is exactly what an interviewer or a future contributor will ask about.

## Decision

Significant decisions are recorded as short Architecture Decision Records (ADRs) in
`docs/adr/`, numbered in order, using the format *Context → Decision → Consequences*.
An ADR is never edited after it's accepted. If a decision changes, a new ADR supersedes it.

## Consequences

- Reasoning stays next to the code it explains, and its history is kept in git.
- Writing an ADR takes about 10 minutes per decision.
