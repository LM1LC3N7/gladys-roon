// The parts of ~/code/ref/gladys-testkit this repository uses, copied so that
// the tests run anywhere (GitHub CI included): clocks, a refused port, a
// silent socket, a logger that keeps its lines.
export { blackhole, refusePort } from './net.mjs';
export { testClock, realClock, spyOn, measurePeriod, settle } from './clock.mjs';

/** A logger keeping `lines` ('warn message ...'). */
export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
