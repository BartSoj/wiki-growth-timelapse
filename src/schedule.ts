// Turns a timeline (versions with file events) into frame times: when each version's slot runs,
// when each tile appears, flashes or goes, which caption is up, and what the counters read.

export type Kind = "add" | "mod" | "del";
export type TimelineEvent = { path: string; kind: Kind; delta: number; page: boolean };
export type TimelineVersion = {
  v: number;
  at: string;
  op: string;
  bookkeeping: boolean;
  caption: string | null;
  events: TimelineEvent[];
};
export type Timing = {
  openingSeconds: number;
  growthSeconds: number;
  pullbackSeconds: number;
  holdSeconds: number;
};
export type Timeline = {
  name: string;
  subtitle: string;
  claim: string;
  unit: string;
  order: string[];
  timing?: Partial<Timing>;
  versions: TimelineVersion[];
  finalFiles: number;
  finalPages: number;
  finalLines: number;
  firstAt: string;
  lastAt: string;
};

export const DEFAULT_TIMING: Timing = {
  openingSeconds: 3,
  growthSeconds: 61,
  pullbackSeconds: 2,
  holdSeconds: 9,
};

export const timingOf = (tl?: Timeline): Timing => ({ ...DEFAULT_TIMING, ...(tl?.timing ?? {}) });

export type Slot = {
  v: number;
  start: number;
  eventsStart: number;
  end: number;
  fromDay: number;
  toDay: number;
};

export type Tile = {
  folder: string;
  isPage: boolean;
  addAt: number;
  deleteAt: number | null;
  baseIndex: number;
  flashes: { t: number; strength: number }[];
};

export type Folder = {
  name: string;
  label: string;
  firstAt: number;
  lastEventTimes: number[];
};

export type CaptionSpan = { text: string; start: number; end: number };

export type Schedule = {
  slots: Slot[];
  tiles: Tile[];
  folders: Folder[];
  captions: CaptionSpan[];
  growthEnd: number;
  lineTimes: number[];
  lineDeltas: number[];
  linePrefix: number[];
};

export type PacingOptions = {
  fps: number;
  startFrame: number;
  growthFrames: number;
  timeZone: string;
  order: string[];
};

export const folderOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";

export const labelOf = (folder: string) => (folder === "." ? "./" : `${folder}/`);

const wordCount = (s: string) =>
  s.split(/\s+/).filter((w) => w && w !== "·").length;

// On screen long enough to read twice: 0.4 s a word, never under 2 s.
export const captionHoldSeconds = (text: string) =>
  Math.max(2, 0.4 * wordCount(text));

export const dayIndex = (iso: string, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  const [y, m, d] = parts.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

// Fixed English short names: Intl output varies by ICU version ("Sep" vs "Sept").
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const formatDay = (day: number, withWeekday: boolean) => {
  const d = new Date(day * 86400000);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withWeekday ? `${WEEKDAYS[d.getUTCDay()]} ${date}` : date;
};

export function buildSchedule(tl: Timeline, o: PacingOptions): Schedule {
  const { fps, startFrame, growthFrames, timeZone } = o;
  const vs = tl.versions;
  const n = vs.length;
  const days = vs.map((v) => dayIndex(v.at, timeZone));

  // Seconds before normalisation. Idle calendar days cost a little, capped; work costs the square
  // root of its size, so a 100-file burst is longer than a 5-file one but not twenty times longer.
  const gap = vs.map((_, i) =>
    i === 0 ? 0 : Math.min(1.5, 0.3 * Math.max(0, days[i] - days[i - 1] - 1)),
  );
  const work = vs.map((v) => {
    if (v.bookkeeping) return 0.3;
    const adds = v.events.filter((e) => e.kind === "add").length;
    return 0.6 + 0.45 * Math.sqrt(adds + 0.35 * (v.events.length - adds));
  });

  const growthSeconds = growthFrames / fps;
  const captioned = vs.map((v, i) => (v.caption ? i : -1)).filter((i) => i >= 0);

  for (let iter = 0; iter < 60; iter++) {
    const total = gap.reduce((a, b) => a + b, 0) + work.reduce((a, b) => a + b, 0);
    const k = growthSeconds / total;
    for (let i = 0; i < n; i++) {
      gap[i] *= k;
      work[i] *= k;
    }
    let ok = true;
    for (let c = 0; c < captioned.length; c++) {
      const a = captioned[c];
      const b = c + 1 < captioned.length ? captioned[c + 1] : n;
      let span = work[a];
      for (let i = a + 1; i < b; i++) span += gap[i] + work[i];
      if (b < n) span += gap[b];
      const need = captionHoldSeconds(vs[a].caption as string);
      if (span < need - 1e-6) {
        ok = false;
        const f = (need / span) * 1.03;
        work[a] *= f;
        for (let i = a + 1; i < b; i++) {
          gap[i] *= f;
          work[i] *= f;
        }
        if (b < n) gap[b] *= f;
      }
    }
    if (ok) break;
  }

  const slots: Slot[] = [];
  let t = startFrame;
  for (let i = 0; i < n; i++) {
    const start = t;
    const eventsStart = start + gap[i] * fps;
    const end = eventsStart + work[i] * fps;
    slots.push({
      v: vs[i].v,
      start,
      eventsStart,
      end,
      fromDay: i === 0 ? days[0] : days[i - 1],
      toDay: days[i],
    });
    t = end;
  }
  const growthEnd = startFrame + growthFrames;

  // Folders in the order given, then any others alphabetically.
  const orderOf = new Map<string, number>();
  o.order.forEach((f, i) => orderOf.set(f, i));
  const rank = (name: string) => orderOf.get(name) ?? o.order.length;

  const tiles: Tile[] = [];
  const current = new Map<string, Tile>();
  const folders = new Map<string, Folder>();
  const perFolder = new Map<string, number>();
  const lineTimes: number[] = [];
  const lineDeltas: number[] = [];

  vs.forEach((v, i) => {
    const s = slots[i];
    const events = [...v.events].sort(
      (a, b) =>
        rank(folderOf(a.path)) - rank(folderOf(b.path)) ||
        folderOf(a.path).localeCompare(folderOf(b.path)) ||
        a.path.localeCompare(b.path),
    );
    // Files arrive across the first 60 % of the slot's working time, so a burst reads as mass.
    const window = v.bookkeeping ? 0 : (s.end - s.eventsStart) * 0.6;
    events.forEach((e, j) => {
      const at = s.eventsStart + (events.length > 1 ? (j / (events.length - 1)) * window : 0);
      const name = folderOf(e.path);
      let f = folders.get(name);
      if (!f) {
        f = { name, label: labelOf(name), firstAt: at, lastEventTimes: [] };
        folders.set(name, f);
      }
      f.lastEventTimes.push(at);
      if (e.delta !== 0) {
        lineTimes.push(at);
        lineDeltas.push(e.delta);
      }
      const existing = current.get(e.path);
      if (e.kind === "add" || !existing) {
        const tile: Tile = {
          folder: name,
          isPage: e.page,
          addAt: at,
          deleteAt: null,
          baseIndex: perFolder.get(name) ?? 0,
          flashes: [],
        };
        perFolder.set(name, tile.baseIndex + 1);
        tiles.push(tile);
        current.set(e.path, tile);
      } else if (e.kind === "mod") {
        existing.flashes.push({ t: at, strength: v.bookkeeping ? 0.35 : 1 });
      } else {
        existing.deleteAt = at;
        current.delete(e.path);
      }
    });
  });

  const linePrefix: number[] = [];
  lineDeltas.reduce((sum, d, i) => (linePrefix[i] = sum + d), 0);

  const captions: CaptionSpan[] = [];
  captioned.forEach((i, c) => {
    const next = captioned[c + 1];
    captions.push({
      text: vs[i].caption as string,
      start: slots[i].eventsStart,
      end: next === undefined ? growthEnd : slots[next].eventsStart,
    });
  });

  const ordered = [...folders.values()].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );

  return { slots, tiles, folders: ordered, captions, growthEnd, lineTimes, lineDeltas, linePrefix };
}

// The calendar day on screen at a frame. Across an idle gap it steps through the empty days.
export function dayAt(s: Schedule, frame: number): number {
  const { slots } = s;
  if (frame < slots[0].start) return slots[0].toDay;
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slots[mid].start <= frame) lo = mid;
    else hi = mid - 1;
  }
  const slot = slots[lo];
  if (frame >= slot.eventsStart || slot.eventsStart === slot.start) return slot.toDay;
  const p = (frame - slot.start) / (slot.eventsStart - slot.start);
  return slot.fromDay + Math.floor(p * (slot.toDay - slot.fromDay));
}

// Total lines at a frame. Each file's change counts up over rampFrames instead of jumping.
export function linesAt(s: Schedule, frame: number, rampFrames: number): number {
  const { lineTimes: t, lineDeltas: d, linePrefix: p } = s;
  let lo = 0;
  let hi = t.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= frame) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (last < 0) return 0;
  let v = p[last];
  for (let j = last; j >= 0 && t[j] > frame - rampFrames; j--) {
    v -= d[j] * (1 - (frame - t[j]) / rampFrames);
  }
  return Math.round(v);
}
