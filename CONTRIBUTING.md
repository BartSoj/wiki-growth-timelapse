# Contributing

Thanks for looking. Issues and pull requests are both welcome, including "this rendered badly for my
wiki, here is a still".

## Getting set up

```sh
npm install
python3 scripts/make_example.py                  # a made-up wiki, no account needed
python3 scripts/build_timeline.py data/example
npx remotion studio                              # WikiTimelapse, props {"timeline":"timelines/example.json"}
```

Node 20+ and Python 3.10+. The Python scripts use the standard library only. You do not need a Syns
account to work on the pacing, the layout or the composition — only to work on the snapshot step.

## Before you open a pull request

```sh
npm run lint                                     # eslint and tsc
python3 -m py_compile scripts/*.py
python3 scripts/make_example.py --out /tmp/ex && python3 scripts/build_timeline.py /tmp/ex
```

If you changed anything about pacing, layout or drawing, render stills and look at them. A frame at
each scene boundary is what `scripts/make.sh` produces; `bun scripts/schedule-dump.ts
public/timelines/example.json` prints the pacing as numbers. Motion is best checked with a contact
sheet of consecutive frames rather than by eye at full speed.

## The one rule that matters

**The build must fail rather than render a wiki that never was.** `scripts/build_timeline.py`
replays every version and stops unless the replay lands on the repository's tree, file by file and
line by line. It also stops when a forbidden word would be on screen, or when a caption cannot be
read in the time it is up. Please do not relax a check to make your wiki build — if your history
makes it fire, that is a bug in the replay or in the snapshot, and the failure output names the
files. Two that have already been found this way:

- a rename is one row naming the new path, with the old path only inside the patch header, so the
  replay kept a ghost of the old file;
- removed `---` frontmatter lines read like diff file headers and were miscounted.

## What is worth doing

- **A `git` adapter.** Produce `history.json`, `diffstats.json` and `tree.json` in the same shapes
  and everything downstream works unchanged. This is the biggest single thing missing.
- **Dense wikis.** One tile pitch covers the whole video, so a wiki with thousands of files gets
  small tiles. It holds at ~2,000. Beyond that it wants a different idea, maybe tiles that stand for
  more than one file.
- **A pacing that reads well for very long histories.** 250 versions in 90 seconds is about the
  limit of what an eye can follow.
- **Sound, chapters, vertical framing, a light palette.** None of it exists.

## Style

Match what is there. Python is standard-library, `argparse`, one job per script. TypeScript is
strict, no classes, small pure functions. Comments explain *why*, especially where a number was
chosen or a bug was fixed — most of the comments in `src/` and `scripts/` are that kind, and please
keep writing them that way rather than restating the code.

## Privacy

Never commit a snapshot or a built timeline from a real wiki: both hold its file paths and raw
version messages. `data/` and `public/timelines/` are ignored apart from the example for exactly
that reason.
