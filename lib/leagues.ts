// Leagues are pure computed ELO tiers — no table, nothing to store. ELO is
// already fetched everywhere a league badge would render.
export interface League {
  name: string;
  color: string;
}

const TIERS: { min: number; name: string; color: string }[] = [
  { min: 2100, name: "Diamond", color: "#06d6a0" },
  { min: 1800, name: "Platinum", color: "#c5e8f0" },
  { min: 1500, name: "Gold", color: "#ffd166" },
  { min: 1200, name: "Silver", color: "#7ab5cc" },
  { min: 0, name: "Bronze", color: "#4a8fa8" },
];

export function getLeague(elo: number): League {
  const tier = TIERS.find((t) => elo >= t.min)!;
  return { name: tier.name, color: tier.color };
}
