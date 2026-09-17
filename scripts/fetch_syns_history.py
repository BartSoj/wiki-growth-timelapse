#!/usr/bin/env python3
"""Snapshot a wiki's version history into data/<name>/ so rendering never calls anything live.

Reads a repository through its version-control CLI (read-only calls only: `history` and `diff`)
plus the working tree on disk, and writes:

  history.json    every version: version, createdAt, message, filesChanged where known
  diffstats.json  per version: [{path, status, added, removed}] from consecutive diffs
  tree.json       the final tree on disk: [{path, lines}]
  log.json        `## [date] op | subject` headings from log.md

Only read-only calls are made; nothing is pulled, pushed or written in the wiki.

Getting *every* version takes some care. A page holds at most 100 versions, and `syns history` has
no offset flag, so the CLI alone cannot reach past the newest 100. Two ways past that:

  --source api   (default when a token is found) pages the server's read-only versions endpoint
                 with an offset, 100 at a time, which returns every version exactly, file lists
                 included. The endpoint the CLI itself calls; the token is the one `syns login`
                 stored.
  --source cli   only ever runs the `syns` binary. It takes the newest page, then recovers older
                 versions file by file: `diff` works for any version pair, so every version's file
                 list is known, and `history --file <path>` dates and describes every version that
                 touched that path. Files are probed most-useful-first. This reaches all of a
                 history under ~100 versions, and most of a longer one, but a version that only
                 touched much-edited files can stay out of reach; the run then says which.

Usage: fetch_syns_history.py --repo ~/.syns/research-atlas --out data/research-atlas [--jobs 8]
                             [--source api|cli]
"""
import argparse, concurrent.futures, fnmatch, json, os, subprocess, sys, urllib.error, urllib.request

CLI = os.environ.get("HISTORY_CLI", "syns")
SERVER = os.environ.get("SYNS_URL", "https://syns.dev").rstrip("/")
PAGE = 100  # both the CLI and the endpoint reject a larger page (verified 2026-09-17)
META = ("author", "createdAt", "message", "sha", "version", "filesChanged")


def run(repo, *args, fatal=True):
    out = subprocess.run([CLI, *args], cwd=repo, capture_output=True, text=True)
    body = json.loads(out.stdout) if out.stdout.strip() else {}
    if out.returncode != 0 or "error" in body:
        if not fatal:
            return None
        sys.exit(f"{CLI} {' '.join(args)} failed: {body.get('error') or out.stderr.strip()}")
    return body


def history_page(repo, path=None):
    args = ["history", "--json", "--limit", str(PAGE)]
    if path:
        args += ["--file", path]
    return run(repo, *args)


def probe(repo, path):
    """One file's history, as far back as the server will go.

    A file-filtered page carries that file's content at every version it returns, so a page of a
    long, much-edited file (a log, an index) can be large enough for the server to answer 500. Ask
    for fewer versions until it answers; a short page still moves the recovery forward.
    """
    for limit in (PAGE, 50, 20, 5, 1):
        page = run(repo, "history", "--json", "--limit", str(limit), "--file", path, fatal=False)
        if page is not None:
            return page["data"]
        print(f"  {path}: no page of {limit}", file=sys.stderr)
    return []


def token():
    """The token `syns login` stored, if there is one. Never printed."""
    if os.environ.get("SYNS_TOKEN"):
        return os.environ["SYNS_TOKEN"]
    dirs = [os.environ.get("SYNS_CONFIG_DIR"),
            os.path.expanduser("~/Library/Application Support/syns"),
            os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "syns")]
    for d in dirs:
        path = os.path.join(d, "credentials.json") if d else None
        if path and os.path.exists(path):
            with open(path) as fh:
                tok = json.load(fh).get("token")
            if tok:
                return tok
    return None


def repo_identity(repo):
    """owner and name from the repository's own config file, which is never modified or copied."""
    path = os.path.join(repo, ".syns.yaml")
    if not os.path.exists(path):
        return None
    fields = {}
    for line in open(path):
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip().strip("\"'")
    if fields.get("owner") and fields.get("name"):
        return fields["owner"], fields["name"]
    return None


def api_versions(owner, name, tok):
    """Every version, newest first, by paging the read-only versions endpoint with an offset."""
    out, offset, total = {}, 0, None
    while total is None or offset < total:
        url = f"{SERVER}/api/v1/repos/{owner}/{name}/versions?limit={PAGE}&offset={offset}"
        # The default urllib user agent is refused at the edge (error 1010), so name ourselves.
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}",
                                                   "User-Agent": "wiki-growth-timelapse"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            sys.exit(f"GET /versions?offset={offset} failed: {e}")
        total = body["total"]
        for v in body["data"]:
            out[v["version"]] = {k: v[k] for k in META if k in v}
        if not body["data"]:
            break
        offset += len(body["data"])
        print(f"versions {len(out)}/{total}", file=sys.stderr)
    missing = [n for n in range(1, total + 1) if n not in out]
    if missing:
        sys.exit(f"the endpoint skipped versions {missing}")
    return out, total


def in_parallel(jobs, fn, items):
    if jobs <= 1:
        return [fn(i) for i in items]
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        return list(pool.map(fn, items))


def count_lines(patch):
    # Count only inside hunks: a removed frontmatter line reads "----" and must not be taken for a
    # file header. Split on newlines only, since content may carry carriage returns.
    added = removed = 0
    in_hunk = False
    for line in patch.split("\n"):
        if line.startswith("diff --git"):
            in_hunk = False
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line.startswith("+"):
            added += 1
        elif in_hunk and line.startswith("-"):
            removed += 1
    return added, removed


def renamed_from(patch):
    """A rename's old path. The row itself carries only the new one."""
    for line in patch.split("\n"):
        if line.startswith("rename from "):
            return line[len("rename from "):].strip()
    return None


def ignored(path, patterns):
    """The repository's own ignore rules, over a path relative to its root.

    A pattern with a slash is matched against the path and each of its parent directories, so
    `media/decks/*/dist/` covers everything under any deck's dist. A bare name is matched against
    every segment, and a trailing slash means directories only.
    """
    parts = path.split("/")
    for p in patterns:
        bare = p.rstrip("/")
        if "/" in bare:
            ancestors = ["/".join(parts[:i + 1]) for i in range(len(parts) - 1)]
            if fnmatch.fnmatch(path, bare) or any(fnmatch.fnmatch(d, bare) for d in ancestors):
                return True
        elif p.endswith("/"):
            if bare in parts[:-1]:
                return True
        elif any(fnmatch.fnmatch(part, bare) for part in parts):
            return True
    return False


def ignore_patterns(repo):
    patterns = [".DS_Store", "__pycache__/", "*.pyc", ".env"]
    path = os.path.join(repo, ".synsignore")
    if os.path.exists(path):
        patterns += [l.strip() for l in open(path) if l.strip() and not l.startswith("#")]
    return patterns


def read_tree(repo, patterns, jobs):
    """Every file the repository holds at its head, with the line count of each.

    The list comes from the repository itself, walked one directory at a time, not from the working
    copy: a working copy also holds whatever has not been pushed, and whatever the repository does
    not take (it versions text, so images stay local). The line counts come from the files on disk,
    which is why a working copy behind the repository is refused rather than guessed at.
    """
    files, pending = [], [""]
    while pending:
        listings = in_parallel(jobs, lambda d: (d, run(repo, *["ls", "--json"], *([d] if d else []))), pending)
        pending = []
        for where, body in listings:
            if body.get("truncated"):
                sys.exit(f"the listing of {where or '/'} came back truncated")
            for e in body["entries"]:
                if ignored(e["path"], patterns):
                    continue
                (pending if e["type"] == "dir" else files).append(e["path"])

    tree, missing = [], []
    for rel in sorted(files):
        full = os.path.join(repo, rel)
        if not os.path.exists(full):
            missing.append(rel)
            continue
        with open(full, "rb") as fh:
            body = fh.read()
        # A last line without a newline is still a line, as a diff counts it.
        tree.append({"path": rel, "lines": body.count(b"\n") + (1 if body and not body.endswith(b"\n") else 0)})
    if missing:
        sys.exit(f"{len(missing)} files are in the repository but not in this working copy "
                 f"(e.g. {', '.join(missing[:3])}); pull first, since their lines are counted on disk")
    return tree


def first_version_files(stats, disk_paths):
    """Paths that must have existed at version 1: the first diff naming them changes or deletes
    them, or no diff names them at all and they are on disk. Same rule as build_timeline.py."""
    first = {}
    for n in sorted(stats, key=int):
        for r in stats[n] or []:
            first.setdefault(r["path"], r["status"])
    return sorted({p for p, s in first.items() if s != "added"} |
                  {p for p in disk_paths if p not in first})


def recover(repo, total, versions, stats, seed, jobs):
    """Fill in versions the newest page did not reach, by probing per-file histories."""
    touched = {}
    for n, rows in stats.items():
        for r in rows or []:
            touched.setdefault(int(n), []).append(r["path"])
    tried = set()
    while True:
        missing = [n for n in range(1, total + 1) if n not in versions]
        if not missing:
            return
        score = {}
        for n in missing:
            for p in touched.get(n, []) or seed:
                if p not in tried:
                    score[p] = score.get(p, 0) + 1
        if not score:
            sys.exit(f"could not recover versions {missing}: no unprobed file touches them")
        batch = sorted(score, key=lambda p: (-score[p], p))[:max(jobs, 1)]
        pages = in_parallel(jobs, lambda p: probe(repo, p), batch)
        for path, entries in zip(batch, pages):
            tried.add(path)
            for v in entries:
                # A file-filtered page carries that file's content, not the version's file list.
                versions.setdefault(v["version"], {k: v[k] for k in META if k in v})
        print(f"probed {len(batch)} files, {len(missing)} versions missing → "
              f"{sum(1 for n in range(1, total + 1) if n not in versions)}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--jobs", type=int, default=8, help="parallel read-only calls")
    ap.add_argument("--source", choices=("auto", "api", "cli"), default="auto",
                    help="where version dates and messages come from; diffs always use the CLI")
    a = ap.parse_args()
    repo = os.path.expanduser(a.repo)
    os.makedirs(a.out, exist_ok=True)

    # 1. Every version's date, message and file list — or as many as the CLI can reach.
    identity, tok = repo_identity(repo), token()
    source = a.source
    if source == "auto":
        source = "api" if identity and tok else "cli"
    if source == "api":
        if not identity:
            sys.exit(f"{repo}/.syns.yaml has no owner and name; use --source cli")
        if not tok:
            sys.exit("no token found; run `syns login`, set SYNS_TOKEN, or use --source cli")
        versions, total = api_versions(*identity, tok)
        print(f"{total} versions, all of them, from {SERVER}", file=sys.stderr)
    else:
        first = history_page(repo)
        total = first["total"]
        versions = {v["version"]: v for v in first["data"]}
        print(f"{total} versions, {len(versions)} on the newest page", file=sys.stderr)

    # 2. Per-version file status and line counts from consecutive diffs. Version 1 has no
    #    predecessor to diff against; when its file list is unknown it stays null and the build
    #    step derives it from the later diffs and the final tree.
    patterns = ignore_patterns(repo)

    def diff(n):
        d = run(repo, "diff", "--from", str(n - 1), "--to", str(n), "--json")
        rows = []
        for f in d["files"]:
            patch = f.get("diff") or ""
            if ignored(f["path"], patterns):
                continue  # what the repository ignores is not on disk, so the replay must not hold it
            added, removed = count_lines(patch)
            row = {"path": f["path"], "status": f["status"], "added": added, "removed": removed}
            if f["status"] == "renamed":
                old = renamed_from(patch)
                if old and not ignored(old, patterns):
                    row["from"] = old
                else:
                    # Moved out of, or in from, ignored ground: from the replay's side it is new.
                    row["status"] = "added"
            rows.append(row)
        return rows

    done = [0]

    def diff_logged(n):
        rows = diff(n)
        done[0] += 1
        if done[0] % 25 == 0 or done[0] == total - 1:
            print(f"diffs {done[0]}/{total - 1}", file=sys.stderr)
        return rows

    rows = in_parallel(a.jobs, diff_logged, range(2, total + 1))
    stats = {str(n): r for n, r in zip(range(2, total + 1), rows)}
    v1 = [p for p in versions.get(1, {}).get("filesChanged") or [] if not ignored(p, patterns)]
    stats["1"] = [{"path": p, "status": "added", "added": None, "removed": 0} for p in v1] if v1 else None
    json.dump(stats, open(f"{a.out}/diffstats.json", "w"), indent=1)

    # 3. The final tree on disk, minus what the repository ignores.
    tree = read_tree(repo, patterns, a.jobs)
    json.dump(tree, open(f"{a.out}/tree.json", "w"), indent=1)

    # 4. Whatever is still missing: date and message, one probed file at a time. Version 1's own
    #    file list is unknown here, so it is probed with the files derived to predate every diff.
    if len(versions) < total:
        recover(repo, total, versions, stats, first_version_files(stats, [r["path"] for r in tree]), a.jobs)
    history = [versions[n] for n in range(1, total + 1)]
    for v in history:
        v.pop("messageBody", None)
        v.pop("parentSha", None)
        v.pop("provenance", None)
    json.dump(history, open(f"{a.out}/history.json", "w"), indent=1)

    # 5. log.md headings, the raw material for captions.
    log = []
    logpath = os.path.join(repo, "log.md")
    if os.path.exists(logpath):
        for line in open(logpath):
            if line.startswith("## ["):
                date = line[4:14]
                rest = line[16:].strip()
                op, _, subject = rest.partition(" | ")
                log.append({"date": date, "op": op.strip(), "subject": subject.strip()})
    json.dump(log, open(f"{a.out}/log.json", "w"), indent=1)
    print(f"{total} versions, {len(tree)} files on disk, {len(log)} log entries", file=sys.stderr)


if __name__ == "__main__":
    main()
