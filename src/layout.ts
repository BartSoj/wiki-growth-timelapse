// Folders as bands that flow from the top of the first column down, then into the next column.
// A band takes its place when its folder gets its first file and pushes the bands after it down;
// when a folder empties, the bands after it move back up; a band grows a row at a time. Every
// change is a keyframe the bands ease towards. One tile pitch for the whole video: the largest at
// which every arrangement the wiki ever had fits.

import { Easing } from "remotion";
import { Schedule } from "./schedule";

export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; h: number; col: number };

export type TrackOptions = {
  rect: Rect;
  columns: number;
  labelSize: number;
  bandPad: number;
  bandGap: number;
  columnGap: number;
  tileRatio: number;
  moveFrames: number;
  // A band makes room this many frames before its new tile pops in.
  leadFrames: number;
  // A band gives up a row this many frames after a deletion, once later tiles have slid back.
  settleFrames: number;
};

// from → to eases over moveFrames from the keyframe. A band that changes column does not slide across
// the others: it fades out at jumpFrom and fades in at its new place, starting at jumpAt.
type Segment = {
  from: Box;
  to: Box;
  since: number;
  gone: boolean;
  jumpAt: number | null;
  jumpFrom: Box | null;
} | null;

export type BandTrack = {
  pitch: number;
  tile: number;
  gutter: number;
  perRow: number;
  colW: number;
  labelLine: number;
  tileTop: number;
  bandPad: number;
  moveFrames: number;
  times: number[];
  segments: Map<string, Segment[]>;
};

// JetBrains Mono advances 0.6 em per character.
export const monoWidth = (chars: number, size: number) => chars * 0.6 * size;

const ease = Easing.inOut(Easing.cubic);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  h: a.h + (b.h - a.h) * t,
  col: b.col,
});

const display = (seg: NonNullable<Segment>, t0: number, frame: number, moveFrames: number) => {
  const box = lerpBox(seg.from, seg.to, ease(clamp01((frame - t0) / moveFrames)));
  if (seg.jumpAt === null || seg.jumpFrom === null) return { box, fade: 1 };
  const e = (frame - seg.jumpAt) / moveFrames;
  if (e >= 1) return { box, fade: 1 };
  return e < 0.5 ? { box: seg.jumpFrom, fade: 1 - 2 * e } : { box, fade: 2 * e - 1 };
};

export function buildBandTrack(s: Schedule, o: TrackOptions): BandTrack {
  const { rect, columns } = o;
  const colW = (rect.w - o.columnGap * (columns - 1)) / columns;
  const labelLine = o.labelSize * 1.3;
  const names = s.folders.map((f) => f.name);
  const indexOf = new Map(names.map((n, i) => [n, i]));
  const longest = Math.max(...s.folders.map((f) => f.label.length));
  const gutter = Math.ceil(monoWidth(longest + 5, o.labelSize)) + 16;

  const changes: { t: number; i: number; d: number }[] = [];
  for (const tile of s.tiles) {
    const i = indexOf.get(tile.folder) as number;
    changes.push({ t: tile.addAt - o.leadFrames, i, d: 1 });
    if (tile.deleteAt !== null) changes.push({ t: tile.deleteAt + o.settleFrames, i, d: -1 });
  }
  changes.sort((a, b) => a.t - b.t || b.d - a.d);

  const geometry = (pitch: number) => ({
    perRow: Math.max(1, Math.floor((colW - gutter - 2 * o.bandPad) / pitch)),
    tileTop: o.bandPad + Math.max(0, (labelLine - pitch) / 2),
  });

  // Each distinct arrangement over the video: when it starts, and each folder's rows (0 = absent).
  const statesFor = (perRow: number) => {
    const counts = names.map(() => 0);
    const out: { t: number; rows: number[] }[] = [];
    let last = "";
    for (let k = 0; k < changes.length; ) {
      const t = changes[k].t;
      for (; k < changes.length && changes[k].t === t; k++) counts[changes[k].i] += changes[k].d;
      const rows = counts.map((n) => Math.ceil(n / perRow));
      const key = rows.join(",");
      if (key !== last) {
        out.push({ t, rows });
        last = key;
      }
    }
    return out;
  };

  const place = (rows: number[], pitch: number, tileTop: number) => {
    const boxes: (Box | null)[] = [];
    let col = 0;
    let y = 0;
    let fits = true;
    for (const r of rows) {
      if (r === 0) {
        boxes.push(null);
        continue;
      }
      const h = Math.max(labelLine + 2 * o.bandPad, tileTop + r * pitch + o.bandPad);
      if (y > 0 && y + h > rect.h && col < columns - 1) {
        col++;
        y = 0;
      }
      if (y + h > rect.h) fits = false;
      boxes.push({ x: rect.x + col * (colW + o.columnGap), y: rect.y + y, h, col });
      y += h + o.bandGap;
    }
    return { boxes, fits };
  };

  const fitsAt = (pitch: number) => {
    const g = geometry(pitch);
    return statesFor(g.perRow).every((st) => place(st.rows, pitch, g.tileTop).fits);
  };
  let lo = 6;
  let hi = 60;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAt(mid)) lo = mid;
    else hi = mid;
  }
  let pitch = Math.floor(lo);
  while (pitch > 6 && !fitsAt(pitch)) pitch--;

  const { perRow, tileTop } = geometry(pitch);
  const states = statesFor(perRow);
  const times = states.map((st) => st.t);
  const segments = new Map<string, Segment[]>(names.map((n) => [n, []]));

  states.forEach((state, k) => {
    const { boxes } = place(state.rows, pitch, tileTop);
    names.forEach((name, fi) => {
      const list = segments.get(name) as Segment[];
      const prev = k > 0 ? list[k - 1] : null;
      const shown = prev ? display(prev, times[k - 1], state.t, o.moveFrames).box : null;
      const to = boxes[fi];
      if (to && prev && !prev.gone) {
        const jumping = prev.jumpAt !== null && state.t - prev.jumpAt < o.moveFrames;
        if (prev.to.col !== to.col) {
          list.push({ from: to, to, since: prev.since, gone: false, jumpAt: state.t, jumpFrom: shown });
        } else if (jumping) {
          list.push({ from: prev.to, to, since: prev.since, gone: false, jumpAt: prev.jumpAt, jumpFrom: prev.jumpFrom });
        } else {
          list.push({ from: shown as Box, to, since: prev.since, gone: false, jumpAt: null, jumpFrom: null });
        }
      } else if (to) {
        list.push({ from: to, to, since: state.t, gone: false, jumpAt: null, jumpFrom: null });
      } else if (prev && !prev.gone) {
        list.push({ from: shown as Box, to: shown as Box, since: state.t, gone: true, jumpAt: null, jumpFrom: null });
      } else if (prev && prev.gone && state.t - prev.since < o.moveFrames) {
        list.push({ ...prev, from: prev.to });
      } else {
        list.push(null);
      }
    });
  });

  return {
    pitch,
    tile: Math.round(pitch * o.tileRatio),
    gutter,
    perRow,
    colW,
    labelLine,
    tileTop,
    bandPad: o.bandPad,
    moveFrames: o.moveFrames,
    times,
    segments,
  };
}

// Where a folder's band is at a frame, and how visible.
export function bandAt(track: BandTrack, folder: string, frame: number) {
  const { times } = track;
  let lo = 0;
  let hi = times.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= frame) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (k < 0) return null;
  const seg = (track.segments.get(folder) as Segment[])[k];
  if (!seg) return null;
  const { box, fade } = display(seg, times[k], frame, track.moveFrames);
  const opacity = seg.gone
    ? 1 - clamp01((frame - seg.since) / track.moveFrames)
    : clamp01((frame - seg.since) / 8) * fade;
  return { box, opacity };
}

// Where a tile at a (possibly fractional, while tiles slide back after a deletion) index sits.
export function tileXY(track: BandTrack, box: Box, index: number) {
  const at = (i: number) => ({
    x: box.x + track.gutter + track.bandPad + (i % track.perRow) * track.pitch,
    y: box.y + track.tileTop + Math.floor(i / track.perRow) * track.pitch,
  });
  const a = at(Math.floor(index));
  const b = at(Math.ceil(index));
  const f = index - Math.floor(index);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
