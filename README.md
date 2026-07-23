# Advanced Monopoly

Monopoly with a player-created financial-instrument layer: bank loans, player loans,
insurance, corporations, and rebate cards. See [docs/RULES.md](docs/RULES.md) for the
full game design and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the codebase
is structured and the milestone plan.

## Status

- **M1 — vanilla Monopoly core: complete.** A tested, event-sourced engine for classic
  Monopoly plus a playable hot-seat CLI.
- **M2 — plugin scaffold + Bank Loan card: complete.** The `CardModule` plugin interface
  and registry, the GO order-of-operations sequence (RULES §7), and the Bank Loan card
  (RULES §2.1). Later cards (insurance, corporation, rebate) build on this interface.
- Next: M3 — Insurance (`onPaymentDue` interception). Not started.

## What's implemented (M1)

- Full standard board: 40 tiles, US prices/rents, Chance & Community Chest (all 32 cards)
- Turns, doubles (roll again; three in a row = jail), GO salary
- Buying, and auctions when a purchase is declined
- Rent: streets (monopoly double, houses, hotels), railroads, utilities
- Houses/hotels with even-build/sell rules and the 32-house / 12-hotel bank supply
- Mortgage (half price) / unmortgage (110%, rounded up)
- Jail: pay the fine, use a Get Out of Jail Free card, or roll for doubles (forced fine on the 3rd failure)
- Debt & liquidation: unpayable obligations queue up; the debtor sells/mortgages or declares bankruptcy
- Bankruptcy: buildings liquidate at half price, the estate transfers to the creditor, last player standing wins
- Event sourcing: the game is an append-only event log; state is a pure fold; a seeded RNG makes every game exactly replayable
- Tests: rule unit tests plus a random-bot harness that plays 25 full games asserting money conservation after every command

## What's implemented (M2)

- `CardModule<TCardState>` plugin interface (creation + lifecycle hooks: `onPassGo`,
  `onLandOnTile`, `onPaymentDue`, `onBankruptcy`, `onTransfer`) and a `CardRegistry`
  that dispatches hooks — the engine core stays ignorant of card semantics
- GO order-of-operations (RULES §7): salary first, then card obligations in waterfall
  priority order (loans first)
- **Bank Loan card** (RULES §2.1): $25 creation cost; borrowing limit = total mortgage
  value of the borrower's unmortgaged properties; interest of 25% of the ORIGINAL
  principal due at every GO while any principal remains; partial repayment; failure to
  pay interest → forced liquidation, then bankruptcy seizure by the bank at waterfall
  priority 1
- New commands: `CreateCard` and `RepayLoan`; new events: `CardCreated`,
  `InterestCharged`, `LoanRepaid`, `CardVoided`
- Loan cash mints from the infinite bank; the smoke-test bots now sometimes borrow and
  repay, and the money-conservation invariant accounts for principal, interest, and fee
  flows
- Loan unit tests: borrowing limit, interest at GO, partial repayment,
  interest-triggered liquidation, and bankruptcy seizure by the bank

The engine stays pure: zero runtime dependencies, no I/O, no UI imports. Every rule is
expressed as events + reducer + command validation.

Not yet implemented (by design, later milestones): player-to-player trading, insurance,
corporations, rebate cards, cascading multi-creditor bankruptcy, the simulation harness,
and the UI.

## Run it

```bash
npm install        # installs typescript + tsx (dev-only; the engine has zero runtime deps)
npm test           # unit tests + random-bot invariant tests
npm run play       # hot-seat CLI, prompts for player names
npm run play Alice Bob Carol   # or pass names directly
npm run typecheck
```

### CLI commands

| Phase | Commands |
|---|---|
| Your roll | roll · in jail: fine, card |
| Landed on unowned tile | buy, pass (starts an auction) |
| Auction | bid <amount>, fold |
| Anytime on your turn | build <#>, sell <#>, mort <#>, unmort <#>, board, log |
| End of turn | end |
| In debt | settle, sell <#>, mort <#>, bankrupt |

## Repository layout

```
packages/engine   pure TypeScript game engine (no dependencies, no I/O)
  src/core        events, state/reducer, command engine, constants
  src/board       tiles, dice RNG, chance/chest decks
  src/cards       CardModule interface, registry, loan/ module
  tests           rule tests, loan tests, random-bot smoke harness
packages/cli      hot-seat terminal client
docs/             rules + architecture
```

The dependency rule: clients depend on the engine; the engine depends on nothing.
# advanced-monopoly
Monopoly with a player-created financial-instrument layer (loans, insurance, corporations, rebate cards). Event-sourced TypeScript engine.
