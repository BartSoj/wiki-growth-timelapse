#!/usr/bin/env bash
# One command from a wiki folder to a rendered timelapse.
#
#   scripts/make.sh --wiki ~/.syns/research-atlas --name research-atlas \
#                   --out ~/.syns/personal/videos/2026-09-15-wiki-timelapse --file wiki-timelapse-1080p.mp4
#
# Snapshot history (read-only) → build and verify the timeline → render the video, review stills
# and the poster (last frame) → ffprobe. data/<name>/video.json must exist first; the wiki-timelapse
# skill says how to write it. --skip-fetch reuses the snapshot already in data/<name>/.
set -euo pipefail
cd "$(dirname "$0")/.."

WIKI="" NAME="" OUT="" FILE="" FETCH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --wiki) WIKI=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --file) FILE=$2; shift 2 ;;
    --skip-fetch) FETCH=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$NAME" ] || [ -z "$OUT" ]; then
  echo "usage: make.sh --wiki DIR --name NAME --out DIR [--file NAME.mp4] [--skip-fetch]" >&2
  exit 2
fi
FILE=${FILE:-$NAME-timelapse-1080p.mp4}

if [ "$FETCH" = 1 ]; then
  [ -n "$WIKI" ] || { echo "--wiki is required unless --skip-fetch" >&2; exit 2; }
  python3 scripts/fetch_syns_history.py --repo "$WIKI" --out "data/$NAME"
fi
if [ ! -f "data/$NAME/video.json" ]; then
  echo "data/$NAME/video.json is missing; write it first (.claude/skills/wiki-timelapse/SKILL.md)" >&2
  exit 2
fi
python3 scripts/build_timeline.py "data/$NAME"

read -r OPEN GROW PULL FRAMES < <(python3 -c "
import json
t = {'openingSeconds': 3, 'growthSeconds': 61, 'pullbackSeconds': 2, 'holdSeconds': 9}
t.update(json.load(open('public/timelines/$NAME.json')).get('timing', {}))
f = lambda s: round(s * 30)
print(f(t['openingSeconds']), f(t['growthSeconds']), f(t['pullbackSeconds']), f(sum(t.values())))")
PROPS="{\"timeline\":\"timelines/$NAME.json\"}"
BUNDLE="$(mktemp -d)/bundle"
mkdir -p "$OUT/renders" "$OUT/stills"

npx remotion bundle --out-dir "$BUNDLE" >/dev/null
npx remotion render "$BUNDLE" WikiTimelapse "$OUT/renders/$FILE" --codec=h264 --props="$PROPS"

# Title, growth start, each quarter of growth, growth end, mid pull-back, end card, last frame.
END=$((OPEN + GROW))
for f in $((OPEN / 2)) "$OPEN" $((OPEN + GROW / 4)) $((OPEN + GROW / 2)) $((OPEN + 3 * GROW / 4)) \
         $((END - 1)) $((END + PULL / 2)) $((END + PULL)) $((FRAMES - 1)); do
  npx remotion still "$BUNDLE" WikiTimelapse "$OUT/stills/$(printf %04d "$f").png" --frame="$f" --props="$PROPS" >/dev/null
done
cp "$OUT/stills/$(printf %04d $((FRAMES - 1))).png" "$OUT/renders/poster.png"

ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames \
  -show_entries format=duration,size -of compact "$OUT/renders/$FILE"
