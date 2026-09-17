// Prints the pacing: slot frames per version, caption spans, and line totals.
// Run: bun scripts/schedule-dump.ts [public/timelines/research-atlas.json]
import { readFileSync } from "node:fs";
import { buildSchedule, captionHoldSeconds, linesAt, Timeline, timingOf } from "../src/schedule";

const file = process.argv[2] ?? "public/timelines/research-atlas.json";
const tl = JSON.parse(readFileSync(file, "utf8")) as Timeline;
const fps = 30;
const timing = timingOf(tl);
const s = buildSchedule(tl, {
  fps,
  startFrame: timing.openingSeconds * fps,
  growthFrames: timing.growthSeconds * fps,
  timeZone: "Europe/Amsterdam",
  order: tl.order,
});
for (const [i, sl] of s.slots.entries()) {
  const v = tl.versions[i];
  console.log(
    `v${String(v.v).padStart(3)} ${v.at.slice(0, 10)} frames ${sl.start.toFixed(0).padStart(4)}–${sl.end.toFixed(0).padStart(4)} ` +
      `${((sl.end - sl.start) / fps).toFixed(2)}s n=${v.events.length} lines=${linesAt(s, sl.end + 20, 10)}` +
      `${v.bookkeeping ? " bk" : ""}${v.caption ? "  «" + v.caption + "»" : ""}`,
  );
}
for (const c of s.captions) {
  console.log(`caption ${((c.end - c.start) / fps).toFixed(2)}s (needs ${captionHoldSeconds(c.text).toFixed(1)}) ${c.text}`);
}
console.log(`final lines ${linesAt(s, s.growthEnd + 60, 10)} (timeline says ${tl.finalLines})`);
