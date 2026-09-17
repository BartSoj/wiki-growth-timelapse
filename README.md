# wiki-growth-timelapse

A video of a markdown wiki growing from its first version to today, rendered from its real version
history. Each top-level folder is a band that takes its place when the folder appears and pushes the
others along. Each file is a tile that pops in orange when it is created, flashes when it is
written, and fades when it is deleted. A date ticks, a page counter and a line counter run. History
in, video out — and the build refuses to render a wiki that never was: it replays every version and
stops unless the replay lands on the repository's tree file by file and line by line.

Built for [Syns](https://syns.dev) wikis, which is what the snapshot step reads. Any other
version-control system needs one adapter script and nothing else — see
[Another version-control system](#another-version-control-system).

Roughly 1,400 lines of TypeScript and Python. Two videos have been made with it: a 400-page research
wiki over three and a half weeks, and a 1,600-page GTM wiki over four.

## Try it without a wiki

```sh
npm install
python3 scripts/make_example.py                  # a made-up wiki: 24 versions, 88 pages
python3 scripts/build_timeline.py data/example
npx remotion studio                              # pick WikiTimelapse, props {"timeline":"timelines/example.json"}
```

`make_example.py` invents the folders, files, dates and messages, and writes the same four files a
real snapshot has, so everything downstream runs exactly as it does on a real repository.

## Make one from your own wiki

You need Node 20+, Python 3.10+, and the [`syns`](https://syns.dev) CLI logged in to an account that
can read the repository.

```sh
scripts/make.sh --wiki ~/.syns/my-wiki --name my-wiki --out ~/videos/my-wiki-timelapse
```

That snapshots the history (read-only; nothing is written to your wiki), builds and verifies the
timeline, then renders the mp4, nine review stills at the scene boundaries, and a poster, and prints
`ffprobe`. It needs `data/<name>/video.json` first — the title, the claim, the folder order, the
timing and the captions. To write that file, follow
[`.claude/skills/wiki-timelapse/SKILL.md`](.claude/skills/wiki-timelapse/SKILL.md): it is a runbook
a coding agent can follow end to end, and `data/example/video.json` is a filled-in model.

`--skip-fetch` reuses the snapshot you already have. Rendering itself reads only `public/`.

## Pipeline

| step | file | in → out |
| --- | --- | --- |
| snapshot | `scripts/fetch_syns_history.py` | a wiki → `data/<name>/{history,diffstats,tree,log}.json` |
| describe | `data/<name>/video.json` | written by hand, or by an agent following the skill |
| build | `scripts/build_timeline.py` | → `public/timelines/<name>.json`, or an error and no file |
| pacing | `scripts/schedule-dump.ts` | `bun scripts/schedule-dump.ts public/timelines/<name>.json` |
| render | `src/` | the `WikiTimelapse` composition, props `{"timeline": "timelines/<name>.json"}` |

### What is real, and what is paced

Real, from the history and the repository: which files each version created, changed, moved and
deleted; the order of versions and their dates; every count — pages, files, lines, per folder and
in total; which versions were bookkeeping.

Paced, so it can be watched: the time between versions is compressed, bursts get longer slots and
idle days shrink to a tick of the date. Files inside one version arrive staggered by folder, because
history has no finer grain than the version. Captions are written by you.

### Getting all of the history

A page of history holds at most 100 versions and `syns history` has no offset flag, so the CLI alone
cannot see past the newest 100. The snapshot step handles that two ways:

- `--source api` (the default when a token is found) pages the read-only versions endpoint with an
  offset, 100 at a time, and gets every version exactly. It reads the token `syns login` stored, or
  `$SYNS_TOKEN`.
- `--source cli` only ever runs the `syns` binary: it takes the newest page, then recovers older
  versions file by file, since `diff` works for any version pair and `history --file` dates every
  version that touched a path. This reaches all of a history under ~100 versions and most of a
  longer one; a version that touched only much-edited files can stay out of reach, and the run says
  which.

The file list comes from the repository, not from your working copy, because a working copy also
holds what has not been pushed and what the repository does not take. Line counts are read from
disk, so a working copy behind the repository is refused rather than guessed at.

## Props

| prop | meaning |
| --- | --- |
| `timeline` | path under `public/` of the built timeline; everything about the wiki comes from it |
| `legend` | what the orange means, in words |
| `timeZone` | the zone the dates are shown in |
| `columns` | how many columns the bands flow into |
| `palette` | background, surface, ink, muted, written (orange), tile |

## Source

- `src/schedule.ts` — pacing, tile events, captions, dates, line totals
- `src/layout.ts` — the band track: flow into columns, keyframes, easing, one tile pitch for the whole video
- `src/Timelapse.tsx` — the composition
- `src/Root.tsx` — reads the timeline and takes the duration from its timing
- `scripts/build_timeline.py` — the replay, and every check that can stop a render

## Another version-control system

Write an adapter that produces `history.json`, `diffstats.json` and `tree.json` in the shapes
`scripts/fetch_syns_history.py` writes (`log.json` is optional, and only raw material for
captions). Nothing downstream knows where history came from. A `git` adapter is an obvious next one
and would be a welcome contribution.

## Your wiki's data stays yours

`data/` and `public/timelines/` are ignored by git apart from the example: a snapshot and a built
timeline carry your wiki's file paths and raw version messages. Only the captions you write reach
the screen — the build never draws a raw message — but do check before you publish a render, and
keep a snapshot out of commits.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
Remotion, which does the rendering, [has its own licence](https://www.remotion.dev/docs/license):
free for individuals and small teams, paid for larger companies.
