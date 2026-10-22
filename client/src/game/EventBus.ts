/**
 * Tiny framework-free pub/sub used to bridge the Phaser game layer and the
 * DOM UI layer without either side importing the other.
 */

export type BusHandler = (payload: any) => void;

export class Emitter {
  private map = new Map<string, Set<BusHandler>>();

  on(event: string, handler: BusHandler): void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: BusHandler): void {
    this.map.get(event)?.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[gameBus] handler for "${event}" failed`, err);
      }
    }
  }
}

/** Game -> UI events: 'phase' {phase}, 'result' {RoundResultMsg}, 'dash-cd' {frac},
 *  'player-out' {} (the player was eliminated this round). */
/** UI -> Game commands: 'cmd' {action: UiCommand}. */
export const gameBus = new Emitter();
