import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  interpolateColors,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { zColor } from "@remotion/zod-types";
import { INTER, MONO } from "./fonts";
import { bandAt, Box, buildBandTrack, monoWidth, tileXY } from "./layout";
import {
  buildSchedule,
  dayAt,
  dayIndex,
  formatDay,
  linesAt,
  Tile,
  Timeline,
  timingOf,
} from "./schedule";

// Everything about one wiki (words, folder order, timing, captions) lives in its timeline JSON.
// Props choose the timeline and the look.
export const timelapseSchema = z.object({
  timeline: z.string(),
  legend: z.string(),
  timeZone: z.string(),
  columns: z.number().int().min(1).max(4),
  palette: z.object({
    background: zColor(),
    surface: zColor(),
    ink: zColor(),
    muted: zColor(),
    written: zColor(),
    tile: zColor(),
  }),
  data: z.any().optional(),
});

export type TimelapseProps = z.infer<typeof timelapseSchema>;

const MARGIN = 80;
const LABEL = 26;
const MAP_TOP = 244;
const MAP_BOTTOM = 890;
const COUNTER = 96;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = Easing.bezier(0.33, 1, 0.68, 1);
const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// Inter's tabular figures are about 0.62 em; a comma about 0.3 em.
const figuresWidth = (s: string, size: number) =>
  [...s].reduce((w, ch) => w + (ch === "," ? 0.3 : 0.62) * size, 0);

const Counter: React.FC<{ value: string; label: string; minWidth: number; muted: string }> = ({
  value,
  label,
  minWidth,
  muted,
}) => (
  <div style={{ textAlign: "right", minWidth }}>
    <div style={{ fontSize: COUNTER, fontWeight: 700, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
      {value}
    </div>
    <div style={{ fontSize: 32, color: muted, marginTop: 6 }}>{label}</div>
  </div>
);

export const Timelapse: React.FC<TimelapseProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const c = props.palette;
  const data = props.data as Timeline | undefined;
  const timing = timingOf(data);

  const opening = Math.round(timing.openingSeconds * fps);
  const growth = Math.round(timing.growthSeconds * fps);
  const pull = Math.round(timing.pullbackSeconds * fps);
  const pullStart = opening + growth;

  const schedule = useMemo(
    () =>
      data
        ? buildSchedule(data, {
            fps,
            startFrame: opening,
            growthFrames: growth,
            timeZone: props.timeZone,
            order: data.order ?? [],
          })
        : null,
    [data, fps, opening, growth, props.timeZone],
  );

  const track = useMemo(
    () =>
      schedule
        ? buildBandTrack(schedule, {
            rect: { x: MARGIN, y: MAP_TOP, w: width - 2 * MARGIN, h: MAP_BOTTOM - MAP_TOP },
            columns: props.columns,
            labelSize: LABEL,
            bandPad: 8,
            bandGap: 10,
            columnGap: 40,
            tileRatio: 0.78,
            moveFrames: Math.round(0.5 * fps),
            leadFrames: 6,
            settleFrames: Math.round(1.0 * fps),
          })
        : null,
    [schedule, width, props.columns, fps],
  );

  const deletedByFolder = useMemo(() => {
    const m = new Map<string, Tile[]>();
    for (const t of schedule?.tiles ?? []) {
      if (t.deleteAt === null) continue;
      m.set(t.folder, [...(m.get(t.folder) ?? []), t]);
    }
    return m;
  }, [schedule]);

  if (!data || !schedule || !track) {
    return <AbsoluteFill style={{ backgroundColor: c.background }} />;
  }

  const pullP = interpolate(frame, [pullStart, pullStart + pull], [0, 1], { ...clamp, easing: easeInOut });
  const headerIn = interpolate(frame, [opening - 10, opening + 6], [0, 1], clamp);
  const headerOut = interpolate(frame, [pullStart, pullStart + pull * 0.5], [1, 0], clamp);
  // The pull-back lifts the whole map to the top margin to make room for the end card.
  const shiftY = lerp(0, MARGIN - MAP_TOP, pullP);

  const bands = new Map<string, { box: Box; opacity: number }>();
  for (const fo of schedule.folders) {
    const b = bandAt(track, fo.name, frame);
    if (b) bands.set(fo.name, b);
  }

  // Tiles, and the live counts they produce.
  const counts = new Map<string, number>();
  let pages = 0;
  const tileEls: React.ReactNode[] = [];
  const offset = (track.pitch - track.tile) / 2;
  schedule.tiles.forEach((t, i) => {
    if (frame < t.addAt) return;
    const gone = t.deleteAt !== null && frame >= t.deleteAt;
    if (!gone) {
      counts.set(t.folder, (counts.get(t.folder) ?? 0) + 1);
      if (t.isPage) pages++;
    }
    const del = gone ? clamp01((frame - (t.deleteAt as number)) / (0.6 * fps)) : 0;
    const band = bands.get(t.folder);
    if (del >= 1 || !band) return;

    let index = t.baseIndex;
    for (const d of deletedByFolder.get(t.folder) ?? []) {
      if (d.baseIndex >= t.baseIndex) continue;
      index -= easeInOut(clamp01((frame - (d.deleteAt as number) - 0.4 * fps) / (0.6 * fps)));
    }
    const p = tileXY(track, band.box, index);

    let heat = 1 - easeOut(clamp01((frame - t.addAt - 0.25 * fps) / (1.2 * fps)));
    for (const fl of t.flashes) {
      if (fl.t > frame) break;
      const rise = clamp01((frame - fl.t) / 3);
      const decay = 1 - easeOut(clamp01((frame - fl.t - 3) / (0.8 * fps)));
      heat = Math.max(heat, fl.strength * rise * decay);
    }
    const pop = spring({ frame: frame - t.addAt, fps, config: { damping: 14, stiffness: 170, mass: 0.7 } });

    tileEls.push(
      <div
        key={i}
        style={{
          position: "absolute",
          left: p.x + offset,
          top: p.y + offset + shiftY,
          width: track.tile,
          height: track.tile,
          borderRadius: track.tile * 0.2,
          backgroundColor: interpolateColors(heat, [0, 1], [c.tile, c.written]),
          scale: `${pop * (1 - easeInOut(del))}`,
          opacity: (1 - del) * band.opacity,
        }}
      />,
    );
  });

  // Folder bands, behind the tiles.
  const bandEls = schedule.folders.map((fo) => {
    const b = bands.get(fo.name);
    if (!b) return null;
    let lastT = -Infinity;
    for (const t of fo.lastEventTimes) {
      if (t > frame) break;
      lastT = t;
    }
    const active = (1 - clamp01((frame - lastT) / fps)) * (1 - pullP);
    const count = counts.get(fo.name) ?? 0;
    const opacity = b.opacity * (count === 0 ? 0.55 : 1);
    const labelCentre = b.box.y + shiftY + track.bandPad + track.labelLine / 2;
    return (
      <React.Fragment key={fo.name}>
        <div
          style={{
            position: "absolute",
            left: b.box.x,
            top: b.box.y + shiftY,
            width: track.colW,
            height: b.box.h,
            borderRadius: 8,
            backgroundColor: c.surface,
            opacity,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: b.box.x + 18,
            width: track.gutter - 30,
            top: labelCentre - LABEL * 0.65,
            height: LABEL * 1.3,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontFamily: MONO,
            fontSize: LABEL,
            lineHeight: 1,
            color: interpolateColors(active, [0, 1], [c.muted, c.ink]),
            opacity,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>{fo.label}</span>
          <span style={{ color: count === 0 ? c.muted : c.ink }}>{count}</span>
        </div>
      </React.Fragment>
    );
  });

  // Title: centred on the empty stage, then shrinks into the header.
  const TITLE_BIG = 96;
  const TITLE_SMALL = 32;
  const move = interpolate(frame, [opening - 18, opening], [0, 1], { ...clamp, easing: easeInOut });
  const titleW = monoWidth(data.name.length, TITLE_BIG);
  const titleScale = lerp(1, TITLE_SMALL / TITLE_BIG, move);
  const titleOpacity = interpolate(frame, [0, 12], [0, 1], clamp) * headerOut;

  // Caption for the version on screen.
  const span = schedule.captions.find((s) => frame >= s.start && frame < s.end);
  const isLast = span === schedule.captions[schedule.captions.length - 1];
  const captionOpacity = span
    ? Math.min(
        interpolate(frame, [span.start, span.start + 8], [0, 1], clamp),
        isLast ? 1 : interpolate(frame, [span.end - 6, span.end], [1, 0], clamp),
      ) * headerOut
    : 0;
  const [op, ...rest] = span ? span.text.split(" · ") : [""];

  const shortDay = (iso: string) => formatDay(dayIndex(iso, props.timeZone), false);
  const endIn = interpolate(frame, [pullStart + pull * 0.5, pullStart + pull + 8], [0, 1], {
    ...clamp,
    easing: easeOut,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: c.background, fontFamily: INTER, color: c.ink }}>
      {bandEls}
      {tileEls}

      <div
        style={{
          position: "absolute",
          left: lerp((width - titleW) / 2, MARGIN, move),
          top: lerp(height / 2 - TITLE_BIG * 0.9, MARGIN, move),
          fontFamily: MONO,
          fontSize: TITLE_BIG,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          transformOrigin: "0 0",
          scale: `${titleScale}`,
          color: interpolateColors(move, [0, 1], [c.ink, c.muted]),
          opacity: titleOpacity,
          translate: `0px ${interpolate(frame, [0, 14], [18, 0], { ...clamp, easing: easeOut })}px`,
        }}
      >
        {data.name}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          width,
          top: height / 2 + TITLE_BIG * 0.45,
          textAlign: "center",
          fontSize: 44,
          color: c.muted,
          opacity: Math.min(
            interpolate(frame, [6, 20], [0, 1], clamp),
            interpolate(frame, [opening - 26, opening - 14], [1, 0], clamp),
          ),
        }}
      >
        {data.subtitle}
      </div>

      <div
        style={{
          position: "absolute",
          left: MARGIN,
          top: 122,
          fontSize: 64,
          fontWeight: 600,
          lineHeight: 1.2,
          opacity: headerIn * headerOut,
        }}
      >
        {formatDay(dayAt(schedule, frame), true)}
      </div>

      <div
        style={{
          position: "absolute",
          right: MARGIN,
          top: 72,
          display: "flex",
          gap: 72,
          opacity: headerIn * headerOut,
        }}
      >
        <Counter
          value={String(pages)}
          label={data.unit}
          minWidth={figuresWidth(String(data.finalPages), COUNTER)}
          muted={c.muted}
        />
        <Counter
          value={thousands(linesAt(schedule, frame, 10))}
          label="lines"
          minWidth={figuresWidth(thousands(data.finalLines), COUNTER)}
          muted={c.muted}
        />
      </div>

      {span ? (
        <div
          style={{
            position: "absolute",
            left: MARGIN,
            top: 922,
            fontSize: 40,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            opacity: captionOpacity,
            translate: `0px ${interpolate(frame, [span.start, span.start + 10], [10, 0], { ...clamp, easing: easeOut })}px`,
          }}
        >
          <span style={{ fontFamily: MONO, fontWeight: 500 }}>{op}</span>
          {rest.length ? <span style={{ color: c.muted }}>{"  ·  "}</span> : null}
          <span>{rest.join(" · ")}</span>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          right: MARGIN,
          top: 934,
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 24,
          color: c.muted,
          opacity: headerIn,
        }}
      >
        <div style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: c.written }} />
        {props.legend}
      </div>

      <div
        style={{
          position: "absolute",
          left: MARGIN,
          top: 760,
          opacity: endIn,
          translate: `0px ${lerp(16, 0, endIn)}px`,
        }}
      >
        <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>
          {`${data.finalPages} ${data.unit}  ·  ${thousands(data.finalLines)} lines  ·  ${data.versions.length} versions`}
        </div>
        <div style={{ fontSize: 36, lineHeight: 1.2, marginTop: 18, color: c.muted }}>
          {`${shortDay(data.firstAt)} → ${shortDay(data.lastAt)}  ·  `}
          <span style={{ fontFamily: MONO }}>{data.name}</span>
          {data.claim ? `  ·  ${data.claim}` : ""}
        </div>
      </div>
    </AbsoluteFill>
  );
};
