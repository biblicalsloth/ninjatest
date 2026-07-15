// Decoupled ask signal: any question UI fires this, the <NinjaPill> listens.
// Avoids threading context/props through every question view.
export const NINJA_ASK_EVENT = "ninja:ask";

export interface NinjaAskDetail {
  matchId: string;
  questionIndex: number;
  label: string; // e.g. "Q4 · DILR"
}

export function askNinja(detail: NinjaAskDetail) {
  window.dispatchEvent(new CustomEvent(NINJA_ASK_EVENT, { detail }));
}

// Global coach open signal: nav button fires this, the global <NinjaCoach> listens.
export const NINJA_COACH_EVENT = "ninja:coach";

export function openNinjaCoach() {
  window.dispatchEvent(new Event(NINJA_COACH_EVENT));
}
