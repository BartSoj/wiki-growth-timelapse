---
name: wiki-timelapse
description: Render or re-render the growth timelapse of a markdown wiki from its real version history — folders as bands, files as tiles, real dates, page and line counts and operations. Use when asked to make the wiki timelapse, update it after the wiki has grown or been restructured, or make the same video for another wiki.
---

# Wiki growth timelapse

One video per wiki: from its first version to now, each top-level folder a band, each file a tile
that pops in orange when created, flashes when written, fades when deleted, with a date, a page
counter, a line counter and a caption per notable operation. The code is this project; each wiki
has a `data/<name>/` folder and a `public/timelines/<name>.json`.

## What is real, and what is paced

Real, from the wiki's history and disk: which files each version created, changed and deleted; the
order of versions and their dates; every count (pages, files, lines per folder and total); which
versions were bookkeeping. The build replays every version and **fails unless the replay lands
exactly on the repository's tree, file by file and line by line**.

Paced, for watching: the time between versions (compressed; bursts get longer slots, idle days
shrink to a quick tick of the date), and the order files arrive *within* one version (history has
no finer grain, so they stagger by folder). Captions are written by you, from the version messages
and the wiki's own log, and are the only authored text besides the title line.

## Rules

- Read the wiki only: the CLI's `history`, `diff` and `ls`, or the read-only versions endpoint, from
  inside the wiki folder. Never pull, push, or create or copy the repository's config file. Never
  write into the wiki.
- Words in `forbid` never reach the screen; the build checks every caption, title and folder name.
- Every number on screen comes from the build or from a version message. Never type a number into a
  caption that its version message does not state.

## Steps

1. **Orient.** Read the wiki's `CLAUDE.md` or `README.md` for what it is and who writes it, and
   the headings of its log (`grep '^## \[' log.md`), if it has one.
2. **Snapshot.** `python3 scripts/fetch_syns_history.py --repo <wiki> --out data/<name>`.
   It writes `history.json`, `diffstats.json`, `tree.json`, `log.json`. A history longer than 100
   versions needs the versions endpoint, which is the default when a token is present; `--source
   cli` stays on the binary and says so if a version is out of reach. The file list comes from the
   repository, so a working copy behind it is refused — pull first. For a wiki in another system,
   write an adapter that produces the same three files; nothing downstream changes.
3. **Write or refresh `data/<name>/video.json`** (see `data/example/video.json`):

   | field | how to fill it |
   | --- | --- |
   | `title` | the wiki's name |
   | `subtitle` | what it is, in six words or fewer, in the wiki's own terms |
   | `claim` | who builds it, only as strongly as its schema and history support; `""` for none |
   | `unit` | what the page counter counts, usually `pages` |
   | `pageGlob` | which files are pages, usually `*.md` |
   | `order` | top-level folders in the wiki's own logic: content first, then sources, then machinery; the root is `.`; unlisted folders follow alphabetically |
   | `timing` | `openingSeconds 3, pullbackSeconds 2, holdSeconds 9`; `growthSeconds` about 61 for ~50 versions, 90 for ~250. Past that an eye cannot follow it |
   | `exclude` | the version-control system's own dotfiles |
   | `forbid` | words that must never be on screen |
   | `bookkeepingPattern`, `bookkeeping` | versions that only touch ledgers or claims, drawn dimmer; force single versions with `{"47": true}` |
   | `captions` | version number → `op · subject` |

   **Captions.** The operation is the version message before `|`. The subject is its subject in
   plain words, at most seven words: no internal IDs (`r-007`, `SF-9`), no jargon a stranger would
   not follow. Caption the versions that changed the wiki's shape (ingests, schema changes,
   deletions, restructures), not every version. The build enforces a budget: each caption is read
   twice (max(2 s, 0.4 s per word)) and all together may use at most 75 % of `growthSeconds`.
   **On a re-run keep existing captions verbatim** unless one is wrong, and caption only the new
   versions; if the budget fails, raise `growthSeconds` or drop the least important captions.
4. **Build.** `python3 scripts/build_timeline.py data/<name>`. It fails, and must not be worked
   around, when the replay differs from the repository, a forbidden word is on screen, or captions exceed the
   budget. `bun scripts/schedule-dump.ts public/timelines/<name>.json` prints the pacing.
5. **Render.** `scripts/make.sh --wiki <wiki> --name <name> --out <video folder> [--file <name>.mp4]`
   renders the video, nine review stills named by frame, and `renders/poster.png`. When a video has
   been made before, its folder's `NOTES.md` holds the exact command and the file name whatever
   embeds it depends on: re-read it rather than renaming anything.
6. **Verify.** Open every still: labels legible, nothing overlapping, 80 px margins, bands not
   clipped. Check ffprobe says h264, 1920×1080, 30 fps, and the duration the timing asks for.
   Recount the end card with tools that are not the build (over the files the repository holds):

   ```sh
   cd <wiki>
   find . -type f -name '*.md' -not -name '.syns*' | wc -l          # pages
   find . -type f -not -name '.DS_Store' -not -name '*.pyc' -not -path '*/__pycache__/*' \
     -not -name '.syns*' -not -name '.env' -exec sh -c 'for f; do c=$(wc -l < "$f");
     if [ -s "$f" ] && [ "$(tail -c1 "$f" | od -An -tx1 | tr -d " ")" != "0a" ]; then c=$((c+1)); fi;
     echo "$c"; done' sh {} + | awk '{s+=$1} END {print s}'          # lines
   ```

   Versions and dates: the first and last entries of `data/<name>/history.json`.
7. **Record.** In the video folder's `NOTES.md`: the render command, the snapshot date, the number
   checks table (value, command, result), and what changed since the previous render.
