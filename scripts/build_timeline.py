#!/usr/bin/env python3
"""Turn a history snapshot into the timeline JSON the video reads.

Input  data/<name>/{history,diffstats,tree}.json   (from fetch_syns_history.py, or any adapter
       that writes the same three files)
       data/<name>/video.json                       (words, folder order, timing, captions)
Output public/timelines/<name>.json

The output is the contract with the video and knows nothing about where history came from:

  { name, subtitle, claim, unit, order, timing,
    versions: [{ v, at, op, bookkeeping, caption, events: [{ path, kind, delta, page }] }],
    finalFiles, finalPages, finalLines, firstAt, lastAt }

kind is "add" | "mod" | "del"; delta is the net change in that file's line count. The build fails
rather than render a wiki that never was: when the replayed files or line counts differ from the
tree the snapshot lists, when an on-screen string holds a forbidden word, or when the captions
cannot each be read twice in the growth time.

Usage: build_timeline.py data/research-atlas [--out public/timelines/research-atlas.json]
"""
import argparse, fnmatch, json, os, re, sys

DEFAULT_TIMING = {"openingSeconds": 3, "growthSeconds": 61, "pullbackSeconds": 2, "holdSeconds": 9}


# Mirrors captionHoldSeconds in src/schedule.ts: read twice, 0.4 s a word, never under 2 s.
def caption_hold(text):
    return max(2.0, 0.4 * len([w for w in text.split() if w != "·"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--out")
    a = ap.parse_args()
    name = os.path.basename(os.path.normpath(a.dir))
    out = a.out or f"public/timelines/{name}.json"

    history = json.load(open(f"{a.dir}/history.json"))
    stats = json.load(open(f"{a.dir}/diffstats.json"))
    tree = json.load(open(f"{a.dir}/tree.json"))
    cfg = json.load(open(f"{a.dir}/video.json"))
    exclude = cfg.get("exclude", [])
    forbid = [w.lower() for w in cfg.get("forbid", [])]
    page_glob = cfg.get("pageGlob", "*.md")
    bk_re = re.compile(cfg.get("bookkeepingPattern", r"ledger|\bclaim"), re.I)
    bk_force = {int(k): v for k, v in cfg.get("bookkeeping", {}).items()}
    captions = {int(k): v for k, v in cfg.get("captions", {}).items()}
    timing = {**DEFAULT_TIMING, **cfg.get("timing", {})}

    def keep(path):
        return not any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(os.path.basename(path), g) for g in exclude)

    disk = {r["path"]: r["lines"] for r in tree}

    # Version 1 has no diff. A file existed at v1 if the first later diff that names it modifies or
    # deletes it, or if it is in the tree and no later diff names it at all.
    if stats.get("1") is None:
        first_seen = {}
        for n in range(2, len(history) + 1):
            for r in stats[str(n)]:
                if r["status"] == "renamed" and r.get("from"):
                    # The path it moved from is the one that already existed.
                    first_seen.setdefault(r["from"], "modified")
                    first_seen.setdefault(r["path"], "added")
                else:
                    first_seen.setdefault(r["path"], r["status"])
        v1 = sorted({p for p, s in first_seen.items() if s != "added"} |
                    {p for p in disk if p not in first_seen})
        stats["1"] = [{"path": p, "status": "added", "added": None, "removed": 0} for p in v1]

    kinds = {"added": "add", "modified": "mod", "deleted": "del", "renamed": "mod"}
    running = {}  # path -> lines replayed so far; relative while its starting size is unknown
    unknown = {}  # path -> its add event, for files no diff gives a starting size (version 1)
    errors = []
    versions = []
    for h in history:
        n = h["version"]
        msg = h["message"]
        op = msg.partition(" | ")[0].strip()
        events = []
        for r in sorted(stats[str(n)], key=lambda r: r["path"]):
            p = r["path"]
            if not keep(p):
                continue
            old = r["from"] if r["status"] == "renamed" else None
            if old in running:
                # A move is one file changing place: it goes from the old band and arrives in the
                # new one. Its lines travel with it, so the two events cancel out in the counter.
                was = running.pop(old)
                events.append({"path": old, "kind": "del", "delta": -was,
                               "page": fnmatch.fnmatch(old, page_glob)})
                if old in unknown:
                    unknown[p] = unknown.pop(old)  # still to be derived, now under the new name
                net = was + r["added"] - r["removed"]
                ev = {"path": p, "kind": "add", "delta": net, "page": fnmatch.fnmatch(p, page_glob)}
                if p in running:  # moved over a file that was already there
                    ev["kind"], ev["delta"] = "mod", net - running[p]
                running[p] = net
                events.append(ev)
                continue
            kind = kinds.get(r["status"], "mod")
            if kind == "add" and p in running:
                kind = "mod"
            if kind == "mod" and p not in running:
                kind = "add"
            ev = {"path": p, "kind": kind, "delta": 0, "page": fnmatch.fnmatch(p, page_glob)}
            if kind == "add":
                if r["added"] is None:
                    running[p] = 0
                    unknown[p] = ev
                else:
                    running[p] = ev["delta"] = r["added"] - r["removed"]
                    unknown.pop(p, None)
            elif kind == "mod":
                ev["delta"] = r["added"] - r["removed"]
                running[p] += ev["delta"]
            else:
                if p in unknown:
                    # Deleting a file removes every line it had: that fixes its starting size.
                    start = r["removed"] - running[p]
                    unknown.pop(p)["delta"] = start
                    running[p] += start
                    if start < 0:
                        errors.append(f"{p}: derived starting size {start}")
                elif running[p] != r["removed"]:
                    errors.append(f"v{n} {p}: deletes {r['removed']} lines, replay holds {running[p]}")
                ev["delta"] = -running.pop(p)
            events.append(ev)
        versions.append({
            "v": n, "at": h["createdAt"], "op": op,
            "bookkeeping": bk_force.get(n, bool(bk_re.search(msg))),
            "caption": captions.get(n), "events": events,
        })

    # A version-1 file still alive: its size on disk, less every later change, is where it started.
    for p, ev in unknown.items():
        start = disk.get(p, 0) - running[p]
        ev["delta"] = start
        running[p] += start
        if start < 0:
            errors.append(f"{p}: derived starting size {start}")

    final = {p for p in disk if keep(p)}
    for p in sorted(set(running) - final):
        errors.append(f"only in replay: {p}")
    for p in sorted(final - set(running)):
        errors.append(f"only in the repository: {p}")
    for p in sorted(final & set(running)):
        if running[p] != disk[p]:
            errors.append(f"{p}: replay has {running[p]} lines, the file has {disk[p]}")
    if errors:
        print(f"replay does not match the repository ({len(errors)}):", *errors[:25], sep="\n  ", file=sys.stderr)
        sys.exit(1)

    missing = sorted(set(captions) - {v["v"] for v in versions})
    if missing:
        sys.exit(f"captions for versions that do not exist: {missing}")
    holds = sum(caption_hold(c) for c in captions.values())
    if holds > 0.75 * timing["growthSeconds"]:
        sys.exit(f"captions need {holds:.1f} s to be read twice; growth is {timing['growthSeconds']} s. "
                 f"Cut captions or raise timing.growthSeconds.")

    doc = {
        "name": cfg.get("title", name),
        "subtitle": cfg.get("subtitle", ""),
        "claim": cfg.get("claim", ""),
        "unit": cfg.get("unit", "pages"),
        "order": cfg.get("order", []),
        "timing": timing,
        "versions": versions,
        "finalFiles": len(final),
        "finalPages": sum(1 for p in final if fnmatch.fnmatch(p, page_glob)),
        "finalLines": sum(disk[p] for p in final),
        "firstAt": history[0]["createdAt"],
        "lastAt": history[-1]["createdAt"],
    }

    on_screen = [doc["name"], doc["subtitle"], doc["claim"], doc["unit"], *captions.values(),
                 *sorted({p.split("/")[0] for p in final if "/" in p})]
    for s in on_screen:
        for w in forbid:
            if w in s.lower():
                sys.exit(f"forbidden word {w!r} in on-screen text {s!r}")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(doc, open(out, "w"), indent=1)
    print(f"{out}: {len(versions)} versions, {doc['finalFiles']} files, {doc['finalPages']} pages, "
          f"{doc['finalLines']} lines, {sum(1 for v in versions if v['bookkeeping'])} bookkeeping, "
          f"{len(captions)} captions needing {holds:.1f} of {timing['growthSeconds']} s", file=sys.stderr)


if __name__ == "__main__":
    main()
