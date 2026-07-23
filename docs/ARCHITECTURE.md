# Advanced Monopoly — Repository Structure & Architecture

Target: digital, hot-seat (single screen), browser-based.

Stack recommendation: TypeScript end to end — one language for engine, UI, and simulation harness, with shared types so the compiler catches rule/UI mismatches.

---

## 1. Repository layout

```
advanced-monopoly/
├── README.md
├── docs/
│   ├── RULES.md                  # the rules document (source of truth for behavior)
│   └── ARCHITECTURE.md           # this file
├── package.json                  # npm workspaces root
├── tsconfig.base.json
└── packages/
    ├── engine/                   # pure game logic — zero UI dependencies
    │   ├── src/
    │   │   ├── core/
    │   │   │   ├── events.ts         # GameEvent union type (the event-sourcing vocabulary)
    │   │   │   ├── eventStore.ts     # append-only log + replay
    │   │   │   ├── state.ts          # GameState projection built by folding events
    │   │   │   ├── turnMachine.ts    # turn phases: roll → move → resolve tile → actions → end
    │   │   │   ├── goSequence.ts     # RULES §7 order of operations at GO
    │   │   │   └── bankruptcy.ts     # waterfall + sequential cascade queue (RULES §8)
    │   │   ├── board/
    │   │   │   ├── tiles.ts          # board definition, standard prices/rents
    │   │   │   ├── dice.ts           # seeded RNG (seed stored in event log → perfect replay)
    │   │   │   └── chanceChest.ts
    │   │   ├── economy/
    │   │   │   ├── payments.ts       # single choke-point for ALL money movement
    │   │   │   ├── mortgage.ts
    │   │   │   ├── liquidation.ts    # forced-sale flow
    │   │   │   └── bank.ts           # infinite bank; house/hotel supply
    │   │   ├── cards/
    │   │   │   ├── CardModule.ts     # the plugin interface (see §3)
    │   │   │   ├── registry.ts       # registers modules, dispatches hooks
    │   │   │   ├── loan/
    │   │   │   │   ├── module.ts
    │   │   │   │   └── module.test.ts
    │   │   │   ├── insurance/
    │   │   │   ├── corporation/
    │   │   │   └── rebate/
    │   │   ├── commands.ts           # player intents: RollDice, BuyProperty, CreateCard, ...
    │   │   ├── validate.ts           # legality checks for every command
    │   │   └── index.ts              # public API: createGame, applyCommand, getState
    │   └── tests/
    │       ├── scenarios/            # full-game scripted tests (esp. bankruptcy cascades)
    │       └── invariants.ts         # money-conservation & consistency checks
    ├── ui/                       # React hot-seat client
    │   ├── src/
    │   │   ├── App.tsx
    │   │   ├── board/                # board render, tokens, dice
    │   │   ├── panels/               # player dashboards: cash, cards, obligations
    │   │   ├── flows/                # multi-step dialogs: create loan, form corporation, trade
    │   │   ├── ledger/               # human-readable event log view (free from event sourcing)
    │   │   └── engineBridge.ts       # ONLY file that imports from engine
    │   └── index.html
    └── sim/                      # headless balance-testing harness
        ├── src/
        │   ├── bots/                 # simple strategy bots (aggressive borrower, insurer, ...)
        │   ├── runner.ts             # play N thousand games, collect stats
        │   └── reports.ts            # game length, bankruptcy causes, card usage rates
        └── ...
```

The dependency rule: ui and sim depend on engine. engine depends on nothing. If the engine ever imports from the UI, the architecture is broken.

---

## 2. Event sourcing

The game is stored as an append-only log of events, not a mutable state object. Current state is a pure function: state = fold(events).

```ts
// core/events.ts (excerpt)
type GameEvent =
  | { type: "GameStarted"; players: PlayerId[]; seed: number }
  | { type: "DiceRolled"; player: PlayerId; d1: number; d2: number }
  | { type: "MoneyTransferred"; from: Account; to: Account; amount: number; reason: PaymentReason }
  | { type: "PropertyPurchased"; player: PlayerId; tile: TileId }
  | { type: "PassedGo"; player: PlayerId }
  | { type: "CardCreated"; card: CardSnapshot }
  | { type: "CardTransferred"; cardId: CardId; from: Owner; to: Owner; consideration?: number }
  | { type: "InterestCharged"; loanId: CardId; amount: number }
  | { type: "ClaimPaid"; policyId: CardId; amount: number; deductible: number }
  | { type: "PlayerBankrupted"; player: PlayerId; creditor: Owner }
  // ...
```

Why this matters for this game specifically:

- Debugging cascades. When a three-player bankruptcy chain resolves wrongly, you replay the exact log and step through it. With mutable state you'd be guessing.
- Undo = truncate the log and re-fold. Essential for hot-seat misclicks.
- The ledger UI (every payment, every interest charge) falls out for free — and in a game about financial instruments, players need that visibility.
- Determinism. Dice use a seeded RNG whose seed lives in the log, so a saved game replays identically. This also makes every bug reproducible.

Invariant test to run after every event: total money delta across all accounts equals bank inflow/outflow. Money is never created or destroyed except by the bank. This one check will catch half your bugs.

---

## 3. The card plugin system

The engine core knows nothing about loans, insurance, corporations, or rebates. It knows only that cards exist and exposes hooks. Each card type is a module implementing:

```ts
// cards/CardModule.ts
interface CardModule<TCardState> {
  readonly kind: CardKind;                       // "loan" | "insurance" | "corporation" | "rebate" | ...
  // Creation
  validateCreate(params: unknown, state: GameState): ValidationResult;
  onCreate(params: TCardState, ctx: EngineContext): GameEvent[];
  // Lifecycle hooks — implement only the ones this card cares about
  onPassGo?(card: Card<TCardState>, passer: PlayerId, ctx: EngineContext): GameEvent[];
  onLandOnTile?(card: Card<TCardState>, lander: PlayerId, tile: TileId, ctx: EngineContext): GameEvent[];
  onPaymentDue?(card: Card<TCardState>, payment: PendingPayment, ctx: EngineContext): PaymentModifier | null;
  onBankruptcy?(card: Card<TCardState>, bankrupt: PlayerId, ctx: EngineContext): BankruptcyClaim | null;
  onTransfer?(card: Card<TCardState>, from: Owner, to: Owner, ctx: EngineContext): GameEvent[];
  // Bankruptcy waterfall position (RULES §8.1)
  readonly priority: number;                     // loan=1, insurance=2, rebate=3, corporation=4
}
```

How the four launch cards map onto the hooks:

| Hook | Loan | Insurance | Corporation | Rebate |
|---|---|---|---|---|
| onPassGo | charge interest on borrower's GO | collect premium, refill tranche, cancellation window | pay distributions on controller's GO | decrement duration on owner's GO |
| onLandOnTile | — | — | route rent income to corp ledger | pay holder if lander ≠ owner |
| onPaymentDue | — | intercept covered $200+ events, apply deductible | — | — |
| onBankruptcy | claim at priority 1; seize collateral | claim at priority 2; void policies | dissolve if controller; transfer if minority | claim at priority 3 |

Adding card type #5 (say, a "futures" card on dice rolls) means writing one new folder under cards/ and registering it. No core engine changes. Given that the entire premise of your game is player-created financial instruments, this is the load-bearing design decision of the whole project.

Card params (interest rate, tranche count, rebate amount, profit-share splits) are data on the card instance, so two loan cards with different rates are the same module with different state.

---

## 4. Command flow

The UI never mutates state. It submits commands; the engine validates and emits events:

```
UI: applyCommand({ type: "CreateCard", kind: "loan", params: {...} })
        │
        ▼
engine/validate.ts     — is it this player's turn? can they afford $25? within borrow limit?
        │ ok
        ▼
cards/registry.ts      — loan module's validateCreate + onCreate
        │
        ▼
eventStore.append([ MoneyTransferred(-25 → bank), CardCreated(...), MoneyTransferred(principal) ])
        │
        ▼
state re-projected → UI re-renders
```

Illegal commands return a structured error; the log is never touched. This gives you rules enforcement in exactly one place.

---

## 5. The simulation harness

packages/sim runs the engine headless with simple bots and answers the balance questions we deferred:

- Is 25%-per-GO interest ever worth taking, or do borrower-bots always lose?
- Is $75/tranche the right bank premium, or does nobody ever buy bank insurance?
- How often do bankruptcy cascades chain 3+ players?
- Median game length with cards vs. vanilla — do rebates/insurance make games drag past the fun threshold?

Because the engine is deterministic and UI-free, running 10,000 games takes minutes. Do this before tuning numbers by feel.

---

## 6. Build order (suggested milestones)

1. M1 — Vanilla core. Board, dice, turns, buying, rent, mortgage, jail, classic bankruptcy. Event store + invariant tests from day one. (You now have working classic Monopoly.)
2. M2 — Plugin scaffold + Loan card. CardModule interface, registry, GO sequence, forced liquidation, waterfall with one priority level. Loans exercise every hard subsystem.
3. M3 — Insurance. Adds onPaymentDue interception and insurer-default rules.
4. M4 — Rebate. Simplest card; quick win that validates onLandOnTile and durations.
5. M5 — Corporation. The hardest card: ledgers, shares, fractioning, control changes, set-bonus suspension, dissolution. Do it last, on a proven foundation.
6. M6 — Cascading bankruptcy. Sequential queue, full multi-creditor scenarios, scripted scenario tests.
7. M7 — Sim harness & tuning. Bots, batch runs, fix the ⚙ values in RULES.md.
8. M8 — UI polish. Trade flows, ledger view, undo, save/load (serialize the event log).

Hot-seat means no server, accounts, or netcode — but keeping the engine pure means online multiplayer later is "put the engine behind a websocket," not a rewrite.
