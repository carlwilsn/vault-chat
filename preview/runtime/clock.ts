// The scenario clock: Date runs from the scenario's start time at real speed,
// and can be pushed forward (`__preview.advance(ms)`) so time-gated UI (a sync
// failure that must last 60 s before the chip shows, amber → red after 10 min)
// is reachable without waiting.

let offset = 0;
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);

export function now(): number {
  return realNow() + offset;
}

export function installClock(startIso?: string): void {
  if (startIso) offset = new RealDate(startIso).getTime() - realNow();
  class PreviewDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(realNow() + offset);
      else super(...(args as []));
    }
    static now(): number {
      return realNow() + offset;
    }
  }
  (window as any).Date = PreviewDate;
}

export function advance(ms: number): void {
  offset += ms;
}
