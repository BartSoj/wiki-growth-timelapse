#!/usr/bin/env python3
"""Write a made-up wiki history into data/example, so the video can be built and watched without a
Syns account or a wiki of your own.

Nobody's wiki: the folders, files, dates and messages here are invented. It writes the same four
files a real snapshot has, so everything downstream — the build's replay check included — runs
exactly as it does on a real repository.

Usage: make_example.py [--out data/example]
"""
import argparse, json, os, random

START = "2026-05-04"
FOLDERS = ["notes", "sources", "questions", "guides", "_meta", "."]
SUBJECTS = ["the first pass", "a second reading", "what the sources agree on", "an open question",
            "the shape of the argument", "three loose ends", "a summary for later",
            "the parts that changed", "a reference walked through", "what is still missing"]
OPS = ["ingest", "grow", "sweep", "schema", "check"]


def day(n):
    # 4 May 2026 was a Monday; keep it to weekdays so the date ticker has gaps to tick through.
    from datetime import date, timedelta
    d = date.fromisoformat(START) + timedelta(days=n)
    return d.isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/example")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = random.Random(7)

    lines = {}            # path -> line count now
    history, stats, log = [], {}, []
    used = {f: 0 for f in FOLDERS}
    offset = 0

    for v in range(1, 25):
        offset += rng.choice([0, 0, 1, 1, 2, 4])
        when = f"{day(offset)}T{9 + v % 9:02d}:{(v * 7) % 60:02d}:11Z"
        op = "init" if v == 1 else rng.choice(OPS)
        subject = "the schema and the log" if v == 1 else rng.choice(SUBJECTS)
        rows, touched = [], []

        adds = 9 if v == 1 else rng.choice([0, 1, 2, 3, 3, 5, 8])
        for _ in range(adds):
            folder = "." if v == 1 and not used["."] else rng.choice(FOLDERS[:5])
            used[folder] += 1
            name = f"{folder}/page-{used[folder]:02d}.md" if folder != "." else f"page-{used['.']:02d}.md"
            n = rng.randint(24, 180)
            lines[name] = n
            rows.append({"path": name, "status": "added", "added": n, "removed": 0})
            touched.append(name)

        for path in rng.sample(sorted(lines), min(len(lines), rng.choice([0, 1, 2, 4]))):
            if path in touched:
                continue
            plus, minus = rng.randint(1, 30), rng.randint(0, 12)
            minus = min(minus, lines[path] - 1)
            lines[path] += plus - minus
            rows.append({"path": path, "status": "modified", "added": plus, "removed": minus})
            touched.append(path)

        if v > 6 and rng.random() < 0.2:
            gone = rng.choice([p for p in sorted(lines) if p not in touched] or [None])
            if gone:
                rows.append({"path": gone, "status": "deleted", "added": 0, "removed": lines.pop(gone)})
                touched.append(gone)

        message = f"{op} | {subject}"
        history.append({"version": v, "createdAt": when, "message": message,
                        "author": "example", "sha": f"{v:040x}", "filesChanged": sorted(touched)})
        stats[str(v)] = rows
        log.append({"date": when[:10], "op": op, "subject": subject})

    tree = [{"path": p, "lines": n} for p, n in sorted(lines.items())]
    for name, doc in (("history", history), ("diffstats", stats), ("tree", tree), ("log", log)):
        json.dump(doc, open(f"{a.out}/{name}.json", "w"), indent=1)

    video = {
        "title": "example-wiki",
        "subtitle": "a made-up wiki, to see this working",
        "claim": "",
        "unit": "pages",
        "pageGlob": "*.md",
        "order": FOLDERS,
        "timing": {"openingSeconds": 3, "growthSeconds": 24, "pullbackSeconds": 2, "holdSeconds": 6},
        "exclude": [],
        "forbid": [],
        "bookkeepingPattern": r"^check\b",
        "bookkeeping": {},
        "captions": {str(v): f"{h['message'].partition(' | ')[0]} · {h['message'].partition(' | ')[2]}"
                     for v, h in zip(range(1, 25), history) if v in (1, 4, 8, 13, 18, 23)},
    }
    path = f"{a.out}/video.json"
    if os.path.exists(path):
        print(f"{path} left as it is")
    else:
        json.dump(video, open(path, "w"), indent=1)
    print(f"{a.out}: {len(history)} versions, {len(tree)} files, {sum(lines.values())} lines")


if __name__ == "__main__":
    main()
