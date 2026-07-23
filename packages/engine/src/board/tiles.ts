/** Standard US Monopoly board. Tile index 0 = GO, proceeding clockwise. */
export type ColorGroup =
  | "brown" | "lightblue" | "pink" | "orange"
  | "red" | "yellow" | "green" | "darkblue";

export type Tile =
  | { kind: "go"; name: string }
  | { kind: "jail"; name: string }
  | { kind: "freeParking"; name: string }
  | { kind: "goToJail"; name: string }
  | { kind: "tax"; name: string; amount: number }
  | { kind: "chance"; name: string }
  | { kind: "chest"; name: string }
  | {
      kind: "street"; name: string; price: number; group: ColorGroup;
      /** rent[0] = base, rent[1..4] = 1-4 houses, rent[5] = hotel */
      rent: [number, number, number, number, number, number];
      houseCost: number;
    }
  | { kind: "railroad"; name: string; price: number }
  | { kind: "utility"; name: string; price: number };

const s = (
  name: string, price: number, group: ColorGroup,
  rent: [number, number, number, number, number, number], houseCost: number,
): Tile => ({ kind: "street", name, price, group, rent, houseCost });

export const TILES: readonly Tile[] = [
  { kind: "go", name: "GO" },
  s("Mediterranean Avenue", 60, "brown", [2, 10, 30, 90, 160, 250], 50),
  { kind: "chest", name: "Community Chest" },
  s("Baltic Avenue", 60, "brown", [4, 20, 60, 180, 320, 450], 50),
  { kind: "tax", name: "Income Tax", amount: 200 },
  { kind: "railroad", name: "Reading Railroad", price: 200 },
  s("Oriental Avenue", 100, "lightblue", [6, 30, 90, 270, 400, 550], 50),
  { kind: "chance", name: "Chance" },
  s("Vermont Avenue", 100, "lightblue", [6, 30, 90, 270, 400, 550], 50),
  s("Connecticut Avenue", 120, "lightblue", [8, 40, 100, 300, 450, 600], 50),
  { kind: "jail", name: "Jail / Just Visiting" },
  s("St. Charles Place", 140, "pink", [10, 50, 150, 450, 625, 750], 100),
  { kind: "utility", name: "Electric Company", price: 150 },
  s("States Avenue", 140, "pink", [10, 50, 150, 450, 625, 750], 100),
  s("Virginia Avenue", 160, "pink", [12, 60, 180, 500, 700, 900], 100),
  { kind: "railroad", name: "Pennsylvania Railroad", price: 200 },
  s("St. James Place", 180, "orange", [14, 70, 200, 550, 750, 950], 100),
  { kind: "chest", name: "Community Chest" },
  s("Tennessee Avenue", 180, "orange", [14, 70, 200, 550, 750, 950], 100),
  s("New York Avenue", 200, "orange", [16, 80, 220, 600, 800, 1000], 100),
  { kind: "freeParking", name: "Free Parking" },
  s("Kentucky Avenue", 220, "red", [18, 90, 250, 700, 875, 1050], 150),
  { kind: "chance", name: "Chance" },
  s("Indiana Avenue", 220, "red", [18, 90, 250, 700, 875, 1050], 150),
  s("Illinois Avenue", 240, "red", [20, 100, 300, 750, 925, 1100], 150),
  { kind: "railroad", name: "B. & O. Railroad", price: 200 },
  s("Atlantic Avenue", 260, "yellow", [22, 110, 330, 800, 975, 1150], 150),
  s("Ventnor Avenue", 260, "yellow", [22, 110, 330, 800, 975, 1150], 150),
  { kind: "utility", name: "Water Works", price: 150 },
  s("Marvin Gardens", 280, "yellow", [24, 120, 360, 850, 1025, 1200], 150),
  { kind: "goToJail", name: "Go To Jail" },
  s("Pacific Avenue", 300, "green", [26, 130, 390, 900, 1100, 1275], 200),
  s("North Carolina Avenue", 300, "green", [26, 130, 390, 900, 1100, 1275], 200),
  { kind: "chest", name: "Community Chest" },
  s("Pennsylvania Avenue", 320, "green", [28, 150, 450, 1000, 1200, 1400], 200),
  { kind: "railroad", name: "Short Line", price: 200 },
  { kind: "chance", name: "Chance" },
  s("Park Place", 350, "darkblue", [35, 175, 500, 1100, 1300, 1500], 200),
  { kind: "tax", name: "Luxury Tax", amount: 100 },
  s("Boardwalk", 400, "darkblue", [50, 200, 600, 1400, 1700, 2000], 200),
];

export const GO_POS = 0;
export const JAIL_POS = 10;
export const GO_SALARY = 200;
export const JAIL_FINE = 50;
export const BOARD_SIZE = 40;
export const HOUSE_SUPPLY = 32;
export const HOTEL_SUPPLY = 12;
export const UNMORTGAGE_INTEREST = 0.1;

export function mortgageValue(tileIdx: number): number {
  const t = TILES[tileIdx];
  if (t.kind === "street" || t.kind === "railroad" || t.kind === "utility") {
    return t.price / 2;
  }
  return 0;
}

/** All tile indices belonging to a color group. */
export function groupTiles(group: ColorGroup): number[] {
  return TILES.flatMap((t, i) => (t.kind === "street" && t.group === group ? [i] : []));
}

export const RAILROAD_TILES = TILES.flatMap((t, i) => (t.kind === "railroad" ? [i] : []));
export const UTILITY_TILES = TILES.flatMap((t, i) => (t.kind === "utility" ? [i] : []));

export const PURCHASABLE = new Set(
  TILES.flatMap((t, i) =>
    t.kind === "street" || t.kind === "railroad" || t.kind === "utility" ? [i] : [],
  ),
);
