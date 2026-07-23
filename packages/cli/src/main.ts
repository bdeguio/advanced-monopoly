/**
 * Hot-seat CLI for the vanilla (M1) engine.
 *   npm run play            -> prompts for players
 *   npm run play Al Bo Cy   -> starts immediately with these names
 */
import * as readline from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import {
  Game, type Command, type GameEvent, type GameState,
  TILES, mortgageValue, currentPlayer,
} from "../../engine/src/index.js";

const rl = readline.createInterface({ input: stdin, output: stdout });

function tileName(i: number): string {
  return `${TILES[i].name} [#${i}]`;
}

function money(n: number): string {
  return `$${n}`;
}

function describe(e: GameEvent, s: GameState): string | null {
  const name = (id: string) => (id === "bank" ? "the bank" : s.players[id]?.name ?? id);
  switch (e.type) {
    case "DiceRolled": return `${name(e.player)} rolls ${e.d1} + ${e.d2}${e.d1 === e.d2 ? " (doubles!)" : ""}`;
    case "UtilityRolled": return `  utility roll: ${e.d1} + ${e.d2}`;
    case "TokenMoved": return `${name(e.player)} moves to ${tileName(e.to)}${e.passedGo ? " (passed GO)" : ""}`;
    case "MoneyTransferred": return `${name(e.from)} pays ${name(e.to)} ${money(e.amount)}${e.memo ? ` — ${e.memo}` : ` (${e.reason})`}`;
    case "PropertyPurchased": return `${name(e.player)} buys ${tileName(e.tile)} for ${money(e.price)}`;
    case "PurchaseDeclined": return `${name(e.player)} declines to buy — auction!`;
    case "AuctionStarted": return `Auction for ${tileName(e.tile)} begins`;
    case "BidPlaced": return `${name(e.player)} bids ${money(e.amount)}`;
    case "AuctionPassed": return `${name(e.player)} drops out`;
    case "AuctionWon": return `${name(e.player)} wins the auction for ${money(e.price)}`;
    case "AuctionAbandoned": return `Nobody bid — ${tileName(e.tile)} stays with the bank`;
    case "CardDrawn": return `${name(e.player)} draws: "${e.text}"`;
    case "JailCardGranted": return `${name(e.player)} keeps a Get Out of Jail Free card`;
    case "JailCardUsed": return `${name(e.player)} uses a Get Out of Jail Free card`;
    case "SentToJail": return `${name(e.player)} goes to JAIL`;
    case "LeftJail": return `${name(e.player)} leaves jail (${e.via})`;
    case "JailTurnServed": return `${name(e.player)} fails to roll doubles (attempt ${e.attempt}/3)`;
    case "SpeedingToJail": return `Three doubles in a row — speeding!`;
    case "HouseBuilt": return `${name(e.player)} builds on ${tileName(e.tile)}`;
    case "HouseSold": return `${name(e.player)} sells a building on ${tileName(e.tile)}`;
    case "PropertyMortgaged": return `${name(e.player)} mortgages ${tileName(e.tile)}`;
    case "PropertyUnmortgaged": return `${name(e.player)} unmortgages ${tileName(e.tile)}`;
    case "DebtRecorded": return `!! ${name(e.debtor)} owes ${name(e.creditor)} ${money(e.amount)} and must raise it`;
    case "DebtSettled": return `${name(e.debtor)} settles the debt`;
    case "PropertyTransferred": return `${tileName(e.tile)} transfers to ${name(e.to)}`;
    case "PlayerBankrupted": return `*** ${name(e.player)} is BANKRUPT ***`;
    case "TurnStarted": return `\n===== Turn ${e.turn}: ${name(e.player)} =====`;
    case "GameEnded": return `\n##### ${name(e.winner)} WINS THE GAME #####`;
    default: return null;
  }
}

function showPlayers(s: GameState): void {
  for (const id of s.order) {
    const p = s.players[id];
    if (p.bankrupt) {
      console.log(`  ${p.name}: BANKRUPT`);
      continue;
    }
    const props = Object.entries(s.properties)
      .filter(([, pr]) => pr.owner === id)
      .map(([t, pr]) => {
        const idx = Number(t);
        let tag = `#${idx}`;
        if (pr.houses === 5) tag += ":HOTEL";
        else if (pr.houses > 0) tag += `:${pr.houses}h`;
        if (pr.mortgaged) tag += ":MTG";
        return tag;
      })
      .join(" ");
    const jail = p.inJail ? ` [JAIL ${p.jailAttempts}/3]` : "";
    const cards = p.jailCards.length ? ` [GOJF x${p.jailCards.length}]` : "";
    console.log(`  ${p.name}: ${money(p.cash)} @ ${TILES[p.pos].name}${jail}${cards}  ${props}`);
  }
}

function showBoard(s: GameState): void {
  for (let i = 0; i < TILES.length; i++) {
    const t = TILES[i];
    const pr = s.properties[i];
    const owner = pr?.owner ? ` — ${s.players[pr.owner].name}${pr.mortgaged ? " (mtg)" : ""}${pr.houses ? ` ${pr.houses === 5 ? "HOTEL" : `${pr.houses}h`}` : ""}` : "";
    const price = "price" in t ? ` ${money(t.price)}` : "";
    console.log(`  #${String(i).padStart(2)} ${t.name}${price}${owner}`);
  }
}

function actorId(s: GameState): string {
  if (s.phase === "liquidation") return s.debts[0].debtor;
  if (s.phase === "auction") return s.auction!.active[s.auction!.turnPtr];
  return currentPlayer(s).id;
}

function promptHelp(s: GameState): string {
  switch (s.phase) {
    case "awaitRoll": {
      const p = currentPlayer(s);
      if (p.inJail) {
        const opts = ["roll (try doubles)"];
        if (p.cash >= 50) opts.push("fine (pay $50)");
        if (p.jailCards.length) opts.push("card (use GOJF)");
        return opts.join(", ") + " | build/sell/mort/unmort <#>, board";
      }
      return "roll | build/sell/mort/unmort <#>, board";
    }
    case "awaitPurchase": {
      const t = TILES[s.pendingPurchase!];
      const price = "price" in t ? t.price : 0;
      return `buy (${money(price)}) or pass (auction) | mort/sell <#> to raise cash, board`;
    }
    case "auction":
      return `bid <amount> (> ${money(s.auction!.highBid)}) or fold`;
    case "awaitEnd":
      return "end | build/sell/mort/unmort <#>, board";
    case "liquidation": {
      const d = s.debts[0];
      return `owe ${money(d.amount)}: settle | sell/mort <#> | bankrupt`;
    }
    default:
      return "";
  }
}

function parse(line: string, s: GameState): Command | "board" | "log" | "quit" | null {
  const [word, arg] = line.trim().toLowerCase().split(/\s+/);
  const p = actorId(s);
  const n = arg !== undefined ? Number(arg) : NaN;
  switch (word) {
    case "roll": return { type: "Roll", player: p };
    case "fine": return { type: "PayJailFine", player: p };
    case "card": return { type: "UseJailCard", player: p };
    case "buy": return { type: "BuyProperty", player: p };
    case "pass": return { type: "DeclineBuy", player: p };
    case "bid": return Number.isFinite(n) ? { type: "Bid", player: p, amount: n } : null;
    case "fold": return { type: "PassAuction", player: p };
    case "build": return Number.isFinite(n) ? { type: "Build", player: p, tile: n } : null;
    case "sell": return Number.isFinite(n) ? { type: "SellHouse", player: p, tile: n } : null;
    case "mort": return Number.isFinite(n) ? { type: "Mortgage", player: p, tile: n } : null;
    case "unmort": return Number.isFinite(n) ? { type: "Unmortgage", player: p, tile: n } : null;
    case "settle": return { type: "SettleDebt", player: p };
    case "bankrupt": return { type: "DeclareBankruptcy", player: p };
    case "end": return { type: "EndTurn", player: p };
    case "board": return "board";
    case "log": return "log";
    case "quit": case "exit": return "quit";
    default: return null;
  }
}

async function main(): Promise<void> {
  let names = argv.slice(2);
  if (names.length < 2) {
    const line = await rl.question("Player names (space-separated, 2-8): ");
    names = line.trim().split(/\s+/).filter(Boolean);
  }
  if (names.length < 2 || names.length > 8) {
    console.log("Need 2-8 players.");
    exit(1);
  }

  const seed = Math.floor(Math.random() * 2 ** 31);
  const g = Game.create(names, seed);
  console.log(`\nAdvanced Monopoly — vanilla core (M1). Seed ${seed}.`);
  console.log(`Mortgage values: half price. Unmortgage: 110%. GO salary $200.\n`);
  console.log(`===== Turn 1: ${names[0]} =====`);

  while (g.state.phase !== "gameOver") {
    const s = g.state;
    showPlayers(s);
    const actor = s.players[actorId(s)];
    const answer = await rl.question(`\n[${actor.name}] ${promptHelp(s)}\n> `);
    const cmd = parse(answer, s);

    if (cmd === null) {
      console.log("Unrecognized command.");
      continue;
    }
    if (cmd === "board") { showBoard(s); continue; }
    if (cmd === "log") {
      for (const e of g.log.slice(-25)) {
        const line = describe(e, g.state);
        if (line) console.log(line);
      }
      continue;
    }
    if (cmd === "quit") break;

    const r = g.apply(cmd);
    if (!r.ok) {
      console.log(`  ✗ ${r.error}`);
      continue;
    }
    console.log();
    for (const e of r.events) {
      const line = describe(e, g.state);
      if (line) console.log(line);
    }
    console.log();
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
