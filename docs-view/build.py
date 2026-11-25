#!/usr/bin/env python3
"""4DD 문서의 두 형식(에이전트용 저장소 문서, 오너용 아티팩트)을 만들고 맞춰 두는 도구.

저장소 문서가 원본이고, 아티팩트 「4DD 개발론」은 이 스크립트가 저장소 문서로 만들어 낸다.

  python3 docs-view/build.py build               docs-view/dist/ 에 아티팩트 페이지를 만든다 (markdown 패키지 필요)
  python3 docs-view/build.py check               동기화와 노드 ID 일치를 검사한다 (git 훅, CI). 문제가 있으면 종료 코드 1
  python3 docs-view/build.py status              지금 상태를 사람이 읽기 좋게 보여 준다
  python3 docs-view/build.py hook-stop           Claude Stop 훅: 어긋나 있으면 멈추지 못하게 한다
  python3 docs-view/build.py hook-post-artifact  Claude PostToolUse(Artifact) 훅: 게시가 끝나면 sync.json에 기록한다
  python3 docs-view/build.py hook-pre-edit       Claude PreToolUse(Edit|Write) 훅: sync.json을 손으로 고치지 못하게 한다
"""
import datetime
import hashlib
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VIEW = ROOT / "docs-view"
DIST = VIEW / "dist"
SYNC = VIEW / "sync.json"
ARTIFACT_URL = "https://claude.ai/artifact/QvwmRXisABunc6DLTiaegf"
REPO_URL = "https://github.com/r0feynman/4DD"
PAGES = [
    ("index.html", "개발론"),
    ("workflow.html", "워크플로"),
    ("harness.html", "하네스 설계"),
    ("glossary.html", "용어집"),
    ("changes.html", "변경 기록"),
]
METHOD = {"스크럼": "scrum", "SDD": "sdd", "BDD": "bdd", "TDD": "tdd", "Figma": "fig"}
NODE_ID = re.compile(r"\bN[0-9][0-9D][FW]?\b")


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- 원본과 해시

def source_files():
    files = [ROOT / "README.md", ROOT / "site" / "index.html", VIEW / "build.py", VIEW / "style.css", VIEW / "nodemap.js"]
    files += sorted((ROOT / "docs").glob("*.md"))
    return sorted(files, key=lambda p: p.relative_to(ROOT).as_posix())


def source_hash():
    h = hashlib.sha256()
    for f in source_files():
        h.update(f.relative_to(ROOT).as_posix().encode())
        h.update(b"\0")
        h.update(f.read_bytes().replace(b"\r\n", b"\n") if f.exists() else b"<missing>")
        h.update(b"\0")
    return h.hexdigest()


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def load_sync():
    try:
        return json.loads(SYNC.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ---------------------------------------------------------------- Markdown 조각 읽기

def section(md, heading):
    """heading으로 시작하는 제목 아래부터, 같거나 높은 단계의 다음 제목 전까지."""
    level = len(heading) - len(heading.lstrip("#"))
    lines = md.splitlines()
    start, fence = None, False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        if start is None:
            if line.startswith(heading):
                start = i + 1
            continue
        m = re.match(r"^(#+)\s", line)
        if m and len(m.group(1)) <= level:
            return "\n".join(lines[start:i])
    if start is None:
        raise BuildError(f"제목을 찾지 못했습니다: {heading}")
    return "\n".join(lines[start:])


def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    cells, cur, tick = [], "", False
    for ch in line:
        if ch == "`":
            tick = not tick
        if ch == "|" and not tick:
            cells.append(cur.strip())
            cur = ""
        else:
            cur += ch
    cells.append(cur.strip())
    return cells


def tables(text):
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        if lines[i].lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:\-|]+\|\s*$", lines[i + 1]):
            header = split_row(lines[i])
            rows = []
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                cells = split_row(lines[i])
                cells += [""] * (len(header) - len(cells))
                rows.append(dict(zip(header, cells)))
                i += 1
            out.append(rows)
        else:
            i += 1
    return out


def first_table(md, heading):
    found = tables(section(md, heading))
    if not found:
        raise BuildError(f"표를 찾지 못했습니다: {heading}")
    return found[0]


def bold_bullets(text):
    """'- **이름:** 내용' 꼴의 목록을 (이름, 내용)으로."""
    out = []
    for line in text.splitlines():
        m = re.match(r"^\s*-\s+\*\*(.+?)\*\*\s*(.*)$", line)
        if m:
            out.append((m.group(1).rstrip(":："), m.group(2).strip()))
    return out


# ---------------------------------------------------------------- HTML 조각

def esc(s):
    return html.escape(s, quote=True)


def inline(s):
    import markdown
    h = markdown.markdown(s).strip()
    m = re.fullmatch(r"<p>(.*)</p>", h, flags=re.S)
    return m.group(1) if m else h


def render_md(text):
    import markdown
    text = re.sub(r"```mermaid\n.*?```", "> 노드 맵 그림은 「개발론」 첫 화면 맨 아래에 있습니다.", text, flags=re.S)
    h = markdown.markdown(text, extensions=["tables", "fenced_code"])
    return h.replace("<table>", '<div class="tbl"><table>').replace("</table>", "</table></div>")


def source_block(*rels):
    parts = [f'<section><details class="source"><summary>원문 펼쳐 보기 · {" · ".join(f"<code>{esc(r)}</code>" for r in rels)}</summary><div class="md">']
    for r in rels:
        parts.append(render_md(read(r)))
    parts.append("</div></details></section>")
    return "".join(parts)


def nav(current):
    current_attr = ' aria-current="page"'
    links = "".join(
        f'<a href="{href}"{current_attr if href == current else ""}>{label}</a>' for href, label in PAGES
    )
    return f'<nav class="topnav" aria-label="4DD 문서"><span class="brand">4DD</span>{links}</nav>'


def stamp(ctx):
    return (
        f'<footer class="stamp"><span>저장소 원본 {ctx["hash"][:12]}</span><span>만든 날 {ctx["date"]}</span>'
        f'<a href="{REPO_URL}">GitHub 저장소</a><span>내용이 다르면 저장소 문서가 기준입니다</span></footer>'
    )


def subpage(ctx, filename, title, body):
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
:root {{ padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }}
body {{ margin: 0; }}
{ctx["css"]}
</style>
</head>
<body>
<div class="wrap">
{nav(filename)}
{body}
{stamp(ctx)}
</div>
</body>
</html>
"""


# ---------------------------------------------------------------- 데이터

def load_nodes(plain=False):
    """docs/nodes.md 표. plain=True면 이름을 HTML로 바꾸지 않는다 (검사는 markdown 모듈 없이 돌아야 한다)."""
    rows = tables(read("docs/nodes.md"))[0]
    nodes, stages = [], {}
    for r in rows:
        st = r["스테이지"].strip()
        num = int(st[0])
        if st[1:].strip():
            stages[num] = st[1:].strip()
        method = METHOD.get(r["방법론"])
        if not method:
            raise BuildError(f"모르는 방법론: {r['방법론']} ({r['ID']})")
        nodes.append({"id": r["ID"], "stage": num, "name": r["이름"] if plain else inline(r["이름"]), "method": method, "kind": r["종류"], "out": r["산출물 · 다음 노드"]})
    return nodes, stages


def chip(n):
    cls = ["chipn", "c-" + n["method"]]
    if n["kind"] == "판단":
        cls.append("decision")
    if n["kind"] == "반복":
        cls.append("repeat")
    if "프로젝트당 1회" in n["name"]:
        cls.append("once")
    return f'<div class="{" ".join(cls)}"><span class="id">{n["id"]}</span><span>{n["name"]}</span></div>'


def flow_card(ctx, title, body_md, notes=False):
    """제목 + 글 상자 안의 "─▶" 흐름(칩) + 첫 문단(+ 목록)으로 된 상자."""
    para = next((p for p in body_md.strip().split("\n\n") if not p.lstrip().startswith(("```", "- "))), "")
    fence = re.search(r"```\n(.*?)```", body_md, flags=re.S)
    steps = [x.strip() for x in fence.group(1).strip().split("─▶")] if fence else []
    arrow = '<span class="arrow" aria-hidden="true">→</span>'
    strip_html = f'<div class="flow-steps">{arrow.join(f"<span class=step>{chipify(ctx, x)}</span>" for x in steps)}</div>' if steps else ""
    items = "".join(f"<li>{chipify(ctx, l[2:].strip())}</li>" for l in body_md.splitlines() if l.startswith("- ")) if notes else ""
    return f'<div class="flow"><h3>{inline(title)}</h3>{strip_html}<p>{inline(para)}</p>' + (f'<ul class="skip-notes">{items}</ul>' if items else "") + "</div>"


def chipify(ctx, text):
    """글 속 노드 ID를 방법론 색 칩으로 바꾼다. "N26부터"처럼 한글이 바로 붙어도 찾는다."""
    return re.sub(r"(?<![A-Za-z0-9])N[0-9][0-9D][FW]?(?![A-Za-z0-9])", lambda m: idchip(ctx, m.group()), inline(text))


def idchip(ctx, token):
    token = token.strip()
    n = ctx["by_id"].get(token)
    if n:
        return f'<span class="idchip c-{n["method"]}">{token}</span>'
    return f'<span class="badge c-human">{esc(token)}</span>'


# ---------------------------------------------------------------- 노드 맵 (Mermaid 원본을 읽어 노드 맵(nodemap.js) 데이터로 바꾼다)

SHAPE = r'(?:\(\[".*?"\]\)|\["[^"]*"\]|\{"[^"]*"\})'
NODE_TOKEN = re.compile(r"\s*([A-Za-z][A-Za-z0-9]*)\s*(" + SHAPE + r")?")
EDGE_TOKEN = re.compile(r"\s*(?:--\s+(?P<l1>.+?)\s+-->|-->|-\.\s+(?P<l2>.+?)\s+\.->|-\.->)")


def parse_map(mmd):
    """workflow.md 노드 맵에서 스테이지별 노드 순서, 노드 글자, 화살표를 읽는다."""
    stages, labels, edges, stage_of = {}, {}, [], {}
    current = None
    for raw in mmd.splitlines():
        line = raw.strip()
        if not line or re.match(r"(flowchart|classDef|class |style |direction|%%)", line):
            continue
        sg = re.match(r'subgraph\s+(\w+)\["(.*)"\]', line)
        if sg:
            st = re.fullmatch(r"ST(\d)", sg.group(1))
            current = int(st.group(1)) if st else None
            if current is not None:
                stages[current] = {"title": sg.group(2), "nodes": []}
            continue
        if line == "end":
            current = None
            continue
        pos, prev, pending = 0, None, None
        while True:
            m = NODE_TOKEN.match(line, pos)
            if not m:
                raise BuildError(f"노드 맵 줄을 읽지 못했습니다: {raw.strip()}")
            nid, shape = m.group(1), m.group(2)
            pos = m.end()
            if shape:
                labels[nid] = re.search(r'"(.*)"', shape, flags=re.S).group(1)
            if current is not None and NODE_ID.fullmatch(nid) and nid not in stage_of:
                stage_of[nid] = current
                stages[current]["nodes"].append(nid)
            if prev is not None:
                edges.append({"src": prev, "dst": nid, "label": pending[0], "dotted": pending[1]})
            e = EDGE_TOKEN.match(line, pos)
            if not e:
                break
            pending = ((e.group("l1") or e.group("l2") or "").strip(), e.group(0).strip().startswith("-."))
            prev, pos = nid, e.end()
        if line[pos:].strip():
            raise BuildError(f"노드 맵 줄 끝을 읽지 못했습니다: {raw.strip()}")
    return stages, labels, edges, stage_of


def map_model():
    wf = read("docs/workflow.md")
    m = re.search(r"```mermaid\n(.*?)```", wf, flags=re.S)
    if not m:
        raise BuildError("docs/workflow.md에서 노드 맵을 찾지 못했습니다")
    stages, labels, edges, stage_of = parse_map(m.group(1))
    outs, conns, gates, ends = {}, {}, [], []
    for e in edges:
        s, d = e["src"], e["dst"]
        if s.startswith("ST") and d.startswith("ST"):
            gates.append((int(s[2:]), int(d[2:]), e["label"]))
            continue
        if not NODE_ID.fullmatch(s):
            continue
        if NODE_ID.fullmatch(d):
            seq = stages[stage_of[s]]["nodes"]
            if stage_of[s] == stage_of[d] and seq.index(d) == seq.index(s) + 1:
                conns[s] = {"to": d, "label": e["label"], "dotted": e["dotted"]}
                kind = "next"
            elif stage_of[s] == stage_of[d] and seq.index(d) < seq.index(s):
                kind = "loop"
            else:
                kind = "aux" if e["dotted"] else "branch"
            target, ghost = d, ""
        elif labels.get(d, "").startswith("■"):
            # ■ 표지: 완성 조건을 모두 채우면 프로젝트를 마치는 곳 (노드가 아니라 끝)
            ends.append({"from": s, "label": e["label"], "text": labels[d].replace("■", "").replace("<br/>", " · ").strip()})
            continue
        else:
            hit = NODE_ID.search(labels.get(d, ""))
            if not hit:
                raise BuildError(f"되돌림 표지 {d}에서 돌아갈 노드를 찾지 못했습니다")
            # ↪ 표지: 개발 중 앞 스테이지로 돌아갔던 작업이 원래 작업으로 돌아오는 곳. 나머지 표지(↩)는 되돌림
            target, kind = hit.group(), ("resume" if labels[d].startswith("↪") else "back")
            ghost = labels[d].split("<br/>")[-1]
        outs.setdefault(s, []).append({"to": target, "label": e["label"], "kind": kind, "note": ghost})
    return stages, labels, outs, conns, gates, ends


def screenless_rows():
    """docs/workflow.md '화면이 없는 작업 유형' 표: [(건너뛰는 노드들, (앞 노드, 뒤 노드) 또는 None=거치지 않음)]."""
    wf = read("docs/workflow.md")
    out = []
    for r in first_table(wf, "## 화면이 없는 작업 유형"):
        skip = NODE_ID.findall(r.get("건너뛰는 노드", ""))
        via = NODE_ID.findall(r.get("대신 가는 경로", ""))
        if not skip or len(via) not in (0, 2):
            raise BuildError(f"'화면이 없는 작업 유형' 표의 줄을 읽지 못했습니다: {r}")
        out.append((skip, tuple(via) if via else None))
    return out


def nodemap_data(plain=False):
    """노드 맵(nodemap.js)에 넣을 데이터. docs/workflow.md 노드 맵 + docs/nodes.md + docs/glossary.md의 TDD 루프."""
    nodes, _ = load_nodes(plain)
    by = {n["id"]: n for n in nodes}
    stages, labels, outs, conns, gates, ends = map_model()
    data = {"stages": [], "nodes": {}, "edges": [], "gates": []}
    for s in sorted(stages):
        data["stages"].append({"n": s, "title": stages[s]["title"].split("·")[-1].strip(), "nodes": stages[s]["nodes"]})
    for nid, n in by.items():
        lab = labels.get(nid, nid).split("<br/>", 1)
        name = re.sub(r"<[^>]+>", "", n["name"])
        data["nodes"][nid] = {"id": nid, "short": lab[1].replace("<br/>", " ") if len(lab) > 1 else name, "name": name,
                              "m": n["method"], "kind": n["kind"], "once": "프로젝트당 1회" in n["name"], "stage": n["stage"]}
    for s, lst in outs.items():
        for o in lst:
            e = {"from": s, "to": o["to"], "kind": o["kind"], "label": o["label"], "note": o["note"]}
            if o["kind"] == "next":
                e["dotted"] = conns[s]["dotted"]
            data["edges"].append(e)
    data["gates"] = [{"from": a, "to": b, "label": l} for a, b, l in gates]
    data["end"] = ends
    # 루프 상자는 용어집의 TDD 루프만 묶는다 (오너 결정 2026-11-18)
    m = re.search(r"(TDD 루프) = (N\w+(?: → N\w+)+)", read("docs/glossary.md"))
    if not m:
        raise BuildError("docs/glossary.md에서 'TDD 루프 = N.. → N..' 정의를 찾지 못했습니다")
    data["loop"] = {"name": m.group(1), "nodes": m.group(2).split(" → ")}
    m = re.search(r"스프린트 \(한 바퀴, ([^)]+)\)", read("docs/workflow.md"))
    data["sprint"] = m.group(1) if m else ""
    # 화면이 없는 작업 유형에서 건너뛰는 노드: 노드 ID → 대신 가는 경로 ("" = 거치지 않음)
    data["skip"] = {nid: (f"{via[0]} → {via[1]}" if via else "") for skip, via in screenless_rows() for nid in skip}
    return data


def nodemap_problems():
    """노드 맵 그림이 원본과 맞는지: 굵은 선 = 앞으로 가는 경로, 스테이지 사이 연결, TDD 루프 위치."""
    try:
        d = nodemap_data(plain=True)
    except BuildError as e:
        return [str(e)]
    out = []
    side = lambda i: d["nodes"][i]["kind"] == "반복" or d["nodes"][i]["once"]
    trunk = {s["n"]: [i for i in s["nodes"] if not side(i)] for s in d["stages"]}
    nexts = {(e["from"], e["to"]) for e in d["edges"] if e["kind"] == "next" and not e.get("dotted")}
    pairs = {(t[k], t[k + 1]) for t in trunk.values() for k in range(len(t) - 1)}
    if pairs != nexts:
        out.append(f"노드 맵의 굵은 선과 원본의 앞으로 가는 경로가 다릅니다: {sorted(pairs ^ nexts)}")
    for g in d["gates"]:
        if not g["label"].startswith(trunk[g["from"]][-1] + " "):
            out.append(f"Stage {g['from']} → {g['to']} 연결이 그 스테이지의 마지막 노드에서 나가지 않습니다: {g['label']}")
    loop = d["loop"]["nodes"]
    if not any(" ".join(loop) in " ".join(t) for t in trunk.values()):
        out.append(f"TDD 루프 {' → '.join(loop)}가 한 스테이지 안에 이 순서로 이어져 있지 않습니다.")
    # 화면이 없는 작업 유형: Figma 노드를 빠짐없이 건너뛰고, 대신 가는 경로가 건너뛴 노드의 바로 앞뒤를 잇는지
    fig = {i for i, n in d["nodes"].items() if n["m"] == "fig"}
    if set(d["skip"]) != fig:
        out.append(f"'화면이 없는 작업 유형' 표의 건너뛰는 노드가 Figma 노드와 다릅니다. 빠짐: {sorted(fig - set(d['skip'])) or '없음'}, 남음: {sorted(set(d['skip']) - fig) or '없음'}")
    for skip, via in screenless_rows():
        if via is None:
            if not all(i in d["nodes"] and side(i) for i in skip):
                out.append(f"'거치지 않음'은 프로젝트당 1회 노드나 반복 노드에만 씁니다: {', '.join(skip)}")
            continue
        a, b = via
        t = trunk.get(d["nodes"][a]["stage"], []) if a in d["nodes"] else []
        if a not in t or b not in t or t[t.index(a) + 1:t.index(b)] != skip:
            out.append(f"'화면이 없는 작업 유형' 표의 {a} → {b}가 건너뛰는 노드 {', '.join(skip)}의 바로 앞뒤를 잇지 않습니다.")
    return out


def nodemap_block(causes_link=""):
    data = json.dumps(nodemap_data(), ensure_ascii=False).replace("</", "<\\/")
    js = (VIEW / "nodemap.js").read_text(encoding="utf-8")
    causes = f'<a href="{causes_link}">실패 원인</a>' if causes_link else "아래 실패 원인"
    return f"""<div class="nm" data-nodemap>
  <div class="nm-legend">
    <span><i class="nm-lg-line"></i>경로 (앞으로 가는 것만 선)</span>
    <span><i class="nm-lg-dot"></i>작업 노드</span>
    <span><i class="nm-lg-dia"></i>판단 노드</span>
    <span><i class="nm-lg-dash"></i>반복 노드 · 프로젝트당 1회</span>
    <span><b class="nm-ret">↩ N23</b>같은 스테이지의 앞 노드로</span>
    <span><b class="nm-up">↩ N03F <small>Stage 0</small></b>앞 스테이지로</span>
    <span><b class="nm-res">↪ N22 <small>Stage 2</small></b>다시 승인받고 원래 작업으로</span>
    <span><b class="nm-spr">↻ N01</b>다음 스프린트</span>
    <span><b class="nm-fin">■ 서비스 완성</b>완성 조건을 모두 채우면 끝</span>
    <span><i class="nm-lg-box"></i>TDD 루프</span>
    <span><b class="nm-skip">화면이 없으면 건너뜀</b>Figma 노드는 화면이 있는 작업 유형에서만</span>
  </div>
  <p class="nm-hint"><b>고리에서 스테이지를 누르면</b> 아래에 그 스테이지의 노드가 열립니다. <b>노드를 누르면</b> 그 노드로 들어오고 나가는 돌아가는 경로가 왼쪽에 곡선으로 나타나고, 관계없는 노드는 흐려집니다. 다시 누르거나 Esc를 누르면 돌아갑니다.</p>
  <div class="nm-cyc"></div>
  <div class="nm-cross"></div>
  <div class="nm-map"></div>
  <p class="nm-hint">표에 적은 "아니오"의 갈 곳은 기본 경로입니다. 실제로 어디로 돌아갈지는 {causes}으로 정합니다.</p>
  <script type="application/json" class="nm-data">{data}</script>
</div>
<script>
{js}
document.querySelectorAll('[data-nodemap]').forEach(fourddNodemapMount);
</script>"""


def legend_methods():
    items = [("scrum", "스크럼"), ("sdd", "SDD 스펙"), ("bdd", "BDD 시나리오"), ("fig", "Figma 디자인"), ("tdd", "TDD 테스트")]
    sw = "".join(f'<span class="swatch c-{k}">{v}</span>' for k, v in items)
    return f'<div class="legend">{sw}<span>◇ 판단 노드</span><span>둥근 칩 = 반복 노드</span><span>점선 칩 = 프로젝트당 1회</span></div>'


# ---------------------------------------------------------------- 페이지: 워크플로

def page_workflow(ctx):
    wf = read("docs/workflow.md")
    nodes, stages = ctx["nodes"], ctx["stages"]
    lanes = []
    for s in sorted(stages):
        chips = "".join(chip(n) for n in nodes if n["stage"] == s)
        lanes.append(f'<div class="lane"><div class="lane-head"><span class="lane-num">{s}</span><b>{esc(stages[s])}</b></div>{chips}</div>')

    routes = []
    for r in first_table(wf, "## 되돌림 경로"):
        targets = "".join(idchip(ctx, t) for t in r["돌아가는 곳"].split("/"))
        routes.append(
            f'<div class="route">{idchip(ctx, r["지점"])}<span class="cond">{inline(r["조건"])}</span>'
            f'<span class="arrow" aria-hidden="true">→</span><span class="targets">{targets}</span>'
            f'<span class="meaning">{inline(r["의미"])}</span></div>'
        )

    causes = []
    cause_rows = first_table(wf, "### 실패 원인")
    for r in cause_rows:
        target = r["돌아가는 곳"].strip()
        n = ctx["by_id"].get(target)
        color = n["method"] if n else "human"
        human = r["승인"].strip() == "사람"
        approve = '<span class="badge c-human">사람 승인</span>' if human else '<span class="badge c-plain">에이전트</span>'
        causes.append(
            f'<div class="cause c-{color}">{inline(r["실패 원인"])}<b>{inline(r["뜻"])}</b>'
            f'<span class="ex">예: {inline(r["예 (로그인)"])}</span>'
            f'<span class="go">돌아가는 곳 {idchip(ctx, target)} {approve}</span>'
            f'<span class="then">고친 뒤 {chipify(ctx, r.get("고친 뒤", ""))}</span></div>'
        )

    meters = []
    for r in first_table(wf, "### 횟수 제한"):
        target, limit = r["대상"], r["한도"]
        m = re.search(r"\d+", limit)
        count = int(m.group()) if m else 0
        color = "fig" if "N26F" in target else "bdd" if "flaky" in target else "sdd" if "작업" in target else "scrum"
        dots = '<span class="dot"></span>' * count
        meters.append(
            f'<div class="meter c-{color}"><span class="name">{inline(target)}<small>{inline(r["셈 방식"])}</small></span>'
            f'<span class="dots" aria-label="{esc(limit)}">{dots}<span class="n">{esc(limit)}</span></span></div>'
        )

    # 되돌림 경로 아래 ### 구역: 글 상자 안의 "─▶" 흐름을 칩 흐름으로, 첫 문단을 설명으로
    rb = section(wf, "## 되돌림 경로")
    route_note = next((p for p in rb.split("### ")[0].strip().split("\n\n") if not p.lstrip().startswith("|")), "")
    flows = [flow_card(ctx, m.group(1).strip(), m.group(2))
             for m in re.finditer(r"^### (.+?)\n(.*?)(?=^### |\Z)", rb, flags=re.M | re.S)]
    done_card = flow_card(ctx, "서비스 완성", section(wf, "## 서비스 완성"), notes=True)

    # 화면이 없는 작업 유형: 건너뛰는 노드를 점선 상자 안에 줄 그어 보여 준다
    skips = []
    for skip, via in screenless_rows():
        gone = '<span class="skipped">' + "".join(idchip(ctx, t) for t in skip) + "</span>"
        arrow = '<span class="arrow" aria-hidden="true">→</span>'
        path = f"{idchip(ctx, via[0])}{arrow}{gone}{arrow}{idchip(ctx, via[1])}" if via else f'{gone}<span class="cond">거치지 않음</span>'
        skips.append(f'<div class="skip">{path}</div>')
    sl = section(wf, "## 화면이 없는 작업 유형")
    sl_intro = next((p for p in sl.strip().split("\n\n") if not p.lstrip().startswith(("|", "-"))), "")
    sl_notes = "".join(f"<li>{inline(l[2:].strip())}</li>" for l in sl.splitlines() if l.startswith("- "))

    decisions = sum(1 for n in nodes if n["kind"] == "판단")
    body = f"""
<header>
  <h1>워크플로</h1>
  <p class="lead">스프린트 한 바퀴를 다섯 스테이지로 나누고, 각 스테이지 안에 노드를 둡니다. 판단 노드에서 실패하면 원인에 따라 앞 노드로 돌아가고, 같은 곳을 너무 많이 돌면 사람을 부릅니다.</p>
  <div class="stats">
    <div class="stat"><b>{len(nodes)}</b><span>노드</span></div>
    <div class="stat"><b>{decisions}</b><span>판단 노드</span></div>
    <div class="stat"><b>{len(routes)}</b><span>되돌림 경로</span></div>
    <div class="stat"><b>{len(cause_rows)}</b><span>실패 원인</span></div>
  </div>
</header>
<section>
  <h2>노드 맵</h2>
  <p>위 고리가 스프린트 한 바퀴(Stage 0 → 4 → 다음 스프린트)입니다. 스테이지를 누르면 아래에 그 스테이지의 노드가 순서대로 열립니다.</p>
  {legend_methods()}
  {nodemap_block()}
</section>
<section>
  <h2>되돌림 경로</h2>
  <p>판단 노드가 "아니오"일 때 돌아가는 기본 경로입니다. 실제로 어디로 갈지는 아래 실패 원인으로 정합니다.</p>
  <div class="routes">{"".join(routes)}</div>
  <p class="route-note">{inline(route_note)}</p>
  {"".join(flows)}
</section>
<section>
  <h2>서비스 완성</h2>
  <p>스프린트를 몇 번 돌지는 완성 조건으로 정합니다.</p>
  {done_card}
</section>
<section>
  <h2>실패 원인</h2>
  <p>실패하면 원인을 정해진 단어로 기록합니다. 카드 위 색은 돌아가는 노드의 방법론 색이고, 노란색은 사람이 받아야 하는 경우입니다.</p>
  <div class="cause-grid">{"".join(causes)}</div>
</section>
<section>
  <h2>횟수 제한</h2>
  <p>점 하나가 실패 한 번입니다. 점이 다 차면 멈추고 사람을 부릅니다.</p>
  <div class="meters">{"".join(meters)}</div>
</section>
<section>
  <h2>화면이 없는 작업 유형</h2>
  <p>{inline(sl_intro)}</p>
  <div class="skips">{"".join(skips)}</div>
  <ul class="skip-notes">{sl_notes}</ul>
</section>
{source_block("docs/workflow.md", "docs/nodes.md", "docs/figma-bdd.md")}
"""
    return subpage(ctx, "workflow.html", "4DD 워크플로", body)


# ---------------------------------------------------------------- 페이지: 하네스 설계

def page_harness(ctx):
    hd = read("docs/harness-design.md")
    palette = ["bdd", "sdd", "scrum", "tdd", "fig"]

    goals = "".join(
        f'<div class="card top c-{palette[i % len(palette)]}"><span class="k">목표</span><span class="t">{inline(k)}</span><span class="d">{inline(v)}</span></div>'
        for i, (k, v) in enumerate(bold_bullets(section(hd, "## 목표")))
    )

    by_date = {}
    dec_rows = first_table(hd, "## 결정 사항")
    for r in dec_rows:
        by_date.setdefault(r["날짜"].strip(), []).append(r)
    timeline = []
    for date in sorted(by_date, reverse=True):
        decs = "".join(f'<div class="dec"><span class="what">{inline(r["항목"])}</span><span class="val">{inline(r["결정"])}</span></div>' for r in by_date[date])
        timeline.append(f'<div class="tl-item"><span class="tl-date">{esc(date)}</span><span class="tl-rail"></span><div class="tl-body"><h3>결정 {len(by_date[date])}건</h3><div class="dec-list">{decs}</div></div></div>')

    open_items = bold_bullets(section(hd, "## 열린 결정"))
    opens = "".join(f'<div class="card top c-human"><span class="k">열린 결정</span><span class="t">{inline(k)}</span><span class="d">{inline(v)}</span></div>' for k, v in open_items)

    layers = "".join(
        f'<div class="layer c-{palette[i % len(palette)]}"><b>{inline(r["층"])}</b><span class="what">{inline(r["무엇"])}<small>{inline(r["형식"])}</small></span><span class="badge c-plain">{inline(r["원본인가"])}</span></div>'
        for i, r in enumerate(first_table(hd, "## 설계 ② 상태 전달"))
    )

    steps = []
    for i, r in enumerate(first_table(hd, "### 강제 규칙을 거는 곳")):
        if steps:
            steps.append('<span class="sep" aria-hidden="true">→</span>')
        steps.append(
            f'<div class="step c-{palette[i % len(palette)]}"><b>{inline(r["층"])}</b><span class="when">{inline(r["언제 걸리나"])} · {inline(r["적용 도구"])}</span><span class="do">{inline(r["하는 일"])}</span></div>'
        )

    tier_rows = first_table(hd, "### 승인 3층")
    tiers = "".join(
        f'<div class="tier c-{["plain", "sdd", "human"][min(i, 2)]}"><span class="lv">L{i}</span><div class="bar" style="width:{60 + 20 * i}%"><b>{inline(r["단계"])}</b><small>{inline(r["누가"])} · {inline(r["언제"])}</small></div></div>'
        for i, r in enumerate(tier_rows)
    )

    areas, cur = {}, ""
    for r in first_table(hd, "## 빈 곳"):
        cur = r["영역"].strip() or cur
        areas.setdefault(cur, []).append(r)
    area_html = "".join(
        f'<div class="area"><h3>{inline(a)}</h3>' + "".join(f'<div class="gap"><span class="gid">{esc(r["ID"])}</span><span>{inline(r["빈 곳"])}</span></div>' for r in rows) + "</div>"
        for a, rows in areas.items()
    )
    gap_count = sum(len(v) for v in areas.values())

    # 설계 ⑥ 스스로 개선하는 루프: 단계 카드, 개선 지표, 승격 등급, 두 층
    loop_html = "".join(
        f'<div class="lstep c-{palette[i % len(palette)]}"><span class="n">{i + 1}</span><b>{inline(r["단계"])}</b>'
        f'<span class="when">{inline(r["언제"])} · {inline(r["누가"])}</span><span class="do">{inline(r["하는 일"])}</span></div>'
        for i, r in enumerate(first_table(hd, "### 개선 단계"))
    )
    kpi_sec = section(hd, "### 개선 지표")
    kpi_note = next((p for p in kpi_sec.strip().split("\n\n") if not p.lstrip().startswith("|")), "")
    kpis = "".join(
        f'<div class="kpi{" kpi-top" if "가장 중요" in r["좋아지는 쪽"] else ""}"><span class="dir">{"↓" if "줄" in r["좋아지는 쪽"] else "↑"}</span>'
        f'<b>{inline(r["지표"])}</b><span>{inline(r["뜻"])}</span>{"<em>가장 중요</em>" if "가장 중요" in r["좋아지는 쪽"] else ""}</div>'
        for r in first_table(hd, "### 개선 지표")
    )
    grades = "".join(
        (lambda c: f'<div class="grade c-{c}"><span class="badge c-{c}">{inline(r["승인"])}</span><b>{inline(r["변경"])}</b><span>{inline(r["조건"])}</span></div>')("human" if "사람" in r["승인"] else "sdd")
        for r in first_table(hd, "### 승격 등급")
    )
    scopes = "".join(
        f'<div class="layer c-{["sdd", "human", "bdd"][i % 3]}"><b>{inline(r["층"])}</b><span class="what">{inline(r["무엇"])}<small>{inline(r["어디"])}</small></span><span class="badge c-plain">{inline(r["올리는 조건"])}</span></div>'
        for i, r in enumerate(first_table(hd, "### 공통 층과 프로젝트 전용 층"))
    )
    less = "".join(
        f'<div class="less-row"><b>{inline(r["지점"])}</b><span class="before">{inline(r["전"])}</span><span class="arrow" aria-hidden="true">→</span><span class="after">{inline(r["후"])}</span></div>'
        for r in first_table(hd, "### 사람 승인 줄이기")
    )

    body = f"""
<header>
  <h1>하네스 설계</h1>
  <p class="lead">4DD 절차를 Claude와 Codex 어디서나 따르게 하는 하네스의 설계입니다. 결정한 것과 아직 열린 것이 여기 모입니다.</p>
  <div class="stats">
    <div class="stat"><b>{len(dec_rows)}</b><span>결정 사항</span></div>
    <div class="stat"><b>{len(open_items)}</b><span>열린 결정</span></div>
    <div class="stat"><b>{gap_count}</b><span>채울 빈 곳</span></div>
  </div>
</header>
<section>
  <h2>목표</h2>
  <div class="cards">{goals}</div>
</section>
<section>
  <h2>열린 결정</h2>
  <p>오너가 정해야 하는 것들입니다.</p>
  <div class="cards">{opens}</div>
</section>
<section>
  <h2>결정 사항</h2>
  <div class="timeline">{"".join(timeline)}</div>
</section>
<section>
  <h2>상태를 넘기는 4층</h2>
  <p>내용은 복사하지 않고 ID와 해시로 가리킵니다. 위 두 층이 원본이고, 아래 두 층은 원본에서 다시 만들 수 있습니다.</p>
  <div class="stack">{layers}</div>
</section>
<section>
  <h2>규칙을 거는 곳</h2>
  <p>규칙은 <code>4dd</code> 명령 한 곳에만 정의하고, 나머지는 그 명령을 부르는 입구입니다. 왼쪽일수록 빨리 걸리고, 오른쪽 CI는 건너뛸 수 없는 마지막 관문입니다.</p>
  <div class="pipeline">{"".join(steps)}</div>
</section>
<section>
  <h2>승인 3층</h2>
  <div class="tiers">{tiers}</div>
</section>
<section>
  <h2>스스로 개선하는 루프</h2>
  <p>루프마다 실패와 사람 개입에서 배우고, 바꾼 것이 정말 나아졌는지 시험한 뒤에만 규칙으로 올립니다.</p>
  <div class="lsteps">{loop_html}<div class="lstep lnext">↻ 다음 루프는 더 짧게</div></div>
  <h3 class="sub">개선 지표</h3>
  <div class="kpis">{kpis}</div>
  <p class="route-note">{inline(kpi_note)}</p>
  <h3 class="sub">승격 등급</h3>
  <div class="grades">{grades}</div>
  <h3 class="sub">공통 층과 프로젝트 전용 층</h3>
  <div class="stack">{scopes}</div>
</section>
<section>
  <h2>사람 개입 줄이기</h2>
  <p>사람은 맞는 제품인지와 기준을 바꿀지만 판단하고, 나머지는 기계 관문과 별도 리뷰 세션이 맡습니다.</p>
  <div class="less">{less}</div>
</section>
<section>
  <h2>채울 빈 곳</h2>
  <div class="areas">{area_html}</div>
</section>
{source_block("docs/harness-design.md")}
"""
    return subpage(ctx, "harness.html", "4DD 하네스 설계", body)


# ---------------------------------------------------------------- 페이지: 용어집

def page_glossary(ctx):
    gl = read("docs/glossary.md")
    m = re.search(r"```\n(.*?)```", section(gl, "## 노드 ID 규칙"), flags=re.S)
    if not m:
        raise BuildError("용어집의 노드 ID 규칙 그림을 찾지 못했습니다")
    lines = [l for l in m.group(1).splitlines() if l.strip()]
    letters = lines[0].split()
    caps = [re.sub(r"^[\s│└─]+", "", l) for l in lines[1:]]
    if len(caps) != len(letters):
        raise BuildError("노드 ID 규칙 그림의 줄 수가 글자 수와 다릅니다")
    colors = ["plain", "sdd", "bdd", "fig"]
    parts = "".join(
        f'<div class="part c-{colors[i % 4]}"><span class="glyph">{esc(letters[i])}</span><span class="cap">{inline(caps[len(letters) - 1 - i])}</span></div>'
        for i in range(len(letters))
    )

    stage_cells = "".join(
        f'<div class="stage-cell"><span class="n">{esc(r["스테이지"])}</span><b>{inline(r["이름"])}</b><small>{inline(r["노드"])}</small><small>스크럼 이벤트 {inline(r["스크럼 공식 이벤트?"])}</small></div>'
        for r in first_table(gl, "## 스테이지")
    )

    struct = first_table(gl, "## 구조 용어")
    method = first_table(gl, "## 방법론 용어")
    terms_a = "".join(f'<div class="term"><b>{inline(r["용어"])}</b><span class="def">{inline(r["정의"])}</span><span class="eg">예: {inline(r["예"])}</span></div>' for r in struct)
    terms_b = "".join(f'<div class="term"><b>{inline(r["용어"])}</b><span class="def">{inline(r["정의"])}</span></div>' for r in method)

    body = f"""
<header>
  <h1>용어집</h1>
  <p class="lead">4DD에서 쓰는 말과 노드 ID 읽는 법입니다.</p>
  <div class="stats">
    <div class="stat"><b>{len(struct)}</b><span>구조 용어</span></div>
    <div class="stat"><b>{len(method)}</b><span>방법론 용어</span></div>
  </div>
</header>
<section>
  <h2>노드 ID 읽는 법</h2>
  <p>예: <code>{esc(" ".join(letters).replace(" ", ""))}</code></p>
  <div class="anatomy">{parts}</div>
</section>
<section>
  <h2>스테이지</h2>
  <div class="stage-row">{stage_cells}</div>
</section>
<section>
  <h2>구조 용어</h2>
  <div class="terms">{terms_a}</div>
</section>
<section>
  <h2>방법론 용어</h2>
  <div class="terms">{terms_b}</div>
</section>
{source_block("docs/glossary.md")}
"""
    return subpage(ctx, "glossary.html", "4DD 용어집", body)


# ---------------------------------------------------------------- 페이지: 변경 기록

def load_changes():
    cl = read("docs/changelog.md")
    entries = []
    for block in re.split(r"^## ", cl, flags=re.M)[1:]:
        head, _, body = block.partition("\n")
        date, _, title = head.partition(" · ")
        info = dict(bold_bullets(body))
        notes = [l[2:].strip() for l in body.splitlines() if l.startswith("- ") and not l.startswith("- **")]
        entries.append({"date": date.strip(), "title": title.strip(), "info": info, "notes": notes})
    if not entries:
        raise BuildError("변경 기록 항목이 없습니다")
    return entries


def page_changes(ctx):
    items = []
    for e in ctx["changes"]:
        chips = []
        if "PR" in e["info"]:
            chips.append(f'<span>PR {inline(e["info"]["PR"])}</span>')
        for key, label, solid in (("새 노드", "새 노드", True), ("바뀐 노드", "바뀐 노드", False)):
            if key in e["info"]:
                ids = "".join(idchip(ctx, t) for t in e["info"][key].split(","))
                chips.append(f'<span class="badge{" solid" if solid else " c-plain"}">{label}</span>{ids}')
        notes = "".join(f"<li>{inline(n)}</li>" for n in e["notes"])
        items.append(
            f'<div class="tl-item"><span class="tl-date">{esc(e["date"])}</span><span class="tl-rail"></span>'
            f'<div class="tl-body"><h3>{inline(e["title"])}</h3>'
            f'{"<div class=chips>" + "".join(chips) + "</div>" if chips else ""}<ul>{notes}</ul></div></div>'
        )
    body = f"""
<header>
  <h1>변경 기록</h1>
  <p class="lead">4DD 문서가 언제, 무엇이 바뀌었는지 최근 것부터 보여 줍니다.</p>
</header>
<section>
  <div class="timeline">{"".join(items)}</div>
</section>
{source_block("docs/changelog.md")}
"""
    return subpage(ctx, "changes.html", "4DD 변경 기록", body)


# ---------------------------------------------------------------- 페이지: 개발론 (첫 화면)

def page_index(ctx):
    src = read("site/index.html")
    for pat in [r"<!doctype html>\s*", r'<html lang="ko">\s*', r"<head>\s*", r'<meta charset="utf-8">\s*',
                r'<meta name="viewport"[^>]*>\s*', r"</head>\s*", r"<body>\s*", r"</body>\s*", r"</html>\s*",
                r'<script type="module">import mermaid[^<]*</script>\s*']:
        src, n = re.subn(pat, "", src, count=1, flags=re.I)
        if n != 1:
            raise BuildError(f"site/index.html 구조가 예상과 다릅니다: {pat}")
    hub_css = re.search(r"/\* @hub-begin.*?@hub-end \*/", ctx["css"], flags=re.S)
    if not hub_css:
        raise BuildError("style.css에 @hub-begin/@hub-end 표시가 없습니다")
    src = src.replace("</style>", "\n" + hub_css.group() + "\n</style>", 1)

    wf = ctx["counts"]
    cards = f"""
  <section>
    <h2>더 깊이 보기</h2>
    <div class="cards">
      <a class="card top c-bdd" href="workflow.html"><span class="k">워크플로</span><span class="t">노드 {wf["nodes"]}개와 되돌림</span><span class="d">스테이지 레인, 실패 원인 {wf["causes"]}개, 횟수 제한</span></a>
      <a class="card top c-sdd" href="harness.html"><span class="k">하네스 설계</span><span class="t">결정 {wf["decisions"]}건 · 열린 결정 {wf["open"]}건</span><span class="d">에이전트가 이 절차를 따르게 하는 구조</span></a>
      <a class="card top c-scrum" href="glossary.html"><span class="k">용어집</span><span class="t">용어 {wf["terms"]}개</span><span class="d">노드 ID 읽는 법, 스테이지, 용어</span></a>
      <a class="card top c-fig" href="changes.html"><span class="k">변경 기록</span><span class="t">{wf["changes"]}건 · 최근 {esc(wf["latest"])}</span><span class="d">언제 무엇이 바뀌었나</span></a>
    </div>
  </section>"""
    for old, new in [('<div class="wrap">', '<div class="wrap">\n' + nav("index.html")), ("</header>", "</header>\n" + cards)]:
        if old not in src:
            raise BuildError(f"site/index.html 에서 {old} 를 찾지 못했습니다")
        src = src.replace(old, new, 1)
    # 사이트의 Mermaid 노드 맵 자리를 아티팩트에서는 노드 맵(시안 나)으로 바꾼다 (원본 데이터는 같다)
    map_section = re.compile(r"(<h2>4DD 스프린트 노드 맵</h2>).*?(\n  </section>)", flags=re.S)
    if not map_section.search(src):
        raise BuildError("site/index.html 에서 노드 맵 구역을 찾지 못했습니다")
    intro = (
        "\n    <p>위 고리가 스프린트 한 바퀴(Stage 0 → 4 → 다음 스프린트)입니다. 노드 색은 방법론을, 마름모는 판단 노드를 뜻합니다. "
        "스테이지를 누르면 아래에 그 스테이지의 노드가 순서대로 열립니다.</p>\n    "
    )
    src = map_section.sub(lambda m: m.group(1) + intro + nodemap_block("workflow.html") + m.group(2), src, count=1)
    tail = src.rfind("</div>\n\n<script>")
    if tail < 0:
        raise BuildError("site/index.html 끝부분 구조가 예상과 다릅니다")
    return src[:tail] + "  " + stamp(ctx) + "\n" + src[tail:]


# ---------------------------------------------------------------- 빌드

def make_context():
    nodes, stages = load_nodes()
    hd = read("docs/harness-design.md")
    gl = read("docs/glossary.md")
    changes = load_changes()
    ctx = {
        "hash": source_hash(),
        "date": datetime.date.today().isoformat(),
        "css": (VIEW / "style.css").read_text(encoding="utf-8"),
        "nodes": nodes,
        "stages": stages,
        "by_id": {n["id"]: n for n in nodes},
        "changes": changes,
    }
    ctx["counts"] = {
        "nodes": len(nodes),
        "causes": len(first_table(read("docs/workflow.md"), "### 실패 원인")),
        "decisions": len(first_table(hd, "## 결정 사항")),
        "open": len(bold_bullets(section(hd, "## 열린 결정"))),
        "terms": len(first_table(gl, "## 구조 용어")) + len(first_table(gl, "## 방법론 용어")),
        "changes": len(changes),
        "latest": changes[0]["date"],
    }
    return ctx


def build():
    problems = node_problems()
    if problems:
        raise BuildError("\n".join(problems))
    ctx = make_context()
    DIST.mkdir(parents=True, exist_ok=True)
    pages = {
        "index.html": page_index(ctx),
        "workflow.html": page_workflow(ctx),
        "harness.html": page_harness(ctx),
        "glossary.html": page_glossary(ctx),
        "changes.html": page_changes(ctx),
    }
    for name, text in pages.items():
        (DIST / name).write_text(text, encoding="utf-8")
    manifest = {"source_hash": ctx["hash"], "built_at": datetime.datetime.now().isoformat(timespec="seconds"), "artifact_url": ARTIFACT_URL, "pages": list(pages)}
    (DIST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"만들었습니다: {DIST.relative_to(ROOT)}/ ({', '.join(pages)})")
    print(publish_hint())


def publish_hint():
    files = {name: f"docs-view/dist/{name}" for name, _ in PAGES[1:]}
    return (
        "다음 단계: Artifact 도구로 게시하세요.\n"
        f"  url: {ARTIFACT_URL}\n"
        "  file_path: docs-view/dist/index.html\n"
        f"  files: {json.dumps(files, ensure_ascii=False)}\n"
        "게시가 끝나면 훅이 docs-view/sync.json에 자동으로 기록합니다."
    )


# ---------------------------------------------------------------- 검사

def node_problems():
    out = []
    try:
        ids_nodes = {r["ID"] for r in tables(read("docs/nodes.md"))[0]}
        wf = read("docs/workflow.md")
        m = re.search(r"```mermaid\n(.*?)```", wf, flags=re.S)
        ids_map = set(NODE_ID.findall(m.group(1))) if m else set()
        ids_site = set(NODE_ID.findall(read("site/index.html")))
    except Exception as e:  # noqa: BLE001
        return [f"노드 ID를 읽지 못했습니다: {e}"]
    for name, ids in (("docs/workflow.md 노드 맵", ids_map), ("site/index.html", ids_site)):
        if ids != ids_nodes:
            miss, extra = sorted(ids_nodes - ids), sorted(ids - ids_nodes)
            out.append(f"{name}의 노드 ID가 docs/nodes.md와 다릅니다. 빠짐: {miss or '없음'}, 남음: {extra or '없음'}")
    out += map_problems(wf)
    out += nodemap_problems()
    return out


def norm_lines(text):
    return [l.strip() for l in text.strip().splitlines() if l.strip()]


def map_problems(wf):
    """노드 맵 두 벌(workflow.md, 사이트)이 같은지, 스테이지를 거꾸로 가는 화살표가 없는지."""
    out = []
    m = re.search(r"```mermaid\n(.*?)```", wf, flags=re.S)
    s = re.search(r'<pre class="mermaid">\n(.*?)</pre>', read("site/index.html"), flags=re.S)
    if not m or not s:
        return ["노드 맵(mermaid)을 docs/workflow.md나 site/index.html에서 찾지 못했습니다."]
    if norm_lines(m.group(1)) != norm_lines(s.group(1)):
        out.append("docs/workflow.md와 site/index.html의 노드 맵이 서로 다릅니다. 같은 내용으로 맞추세요.")
    # 앞 스테이지로 거꾸로 가는 화살표가 있으면 Mermaid가 스테이지 순서를 뒤섞는다 (2026-11-18 오너 지적)
    stage_of = {}
    current = None
    for line in m.group(1).splitlines():
        sg = re.match(r"\s*subgraph\s+ST(\d)\b", line)
        if sg:
            current = int(sg.group(1))
            continue
        if re.match(r"\s*end\s*$", line):
            current = None
            continue
        if current is not None:
            for nid in NODE_ID.findall(re.sub(r'\(\[".*?"\]\)', "", line)):
                stage_of.setdefault(nid, current)
    for line in m.group(1).splitlines():
        line = re.sub(r'\(\[".*?"\]\)|\["[^"]*"\]|\{"[^"]*"\}', "", line)
        ids = re.findall(r"\b(N[0-9][0-9D][FW]?|ST\d)\b", line)
        if not re.search(r"--|-\.", line) or len(ids) < 2:
            continue
        for a, b in zip(ids, ids[1:]):
            sa = int(a[2]) if a.startswith("ST") else stage_of.get(a)
            sb = int(b[2]) if b.startswith("ST") else stage_of.get(b)
            if sa is not None and sb is not None and sb < sa:
                out.append(f"노드 맵에 앞 스테이지로 거꾸로 가는 화살표가 있습니다: {a} → {b}. 그림 순서가 뒤섞이니 '↩ {b}' 표지로 바꾸세요.")
    return out


def problems():
    out = node_problems()
    sync = load_sync()
    if sync.get("source_hash") != source_hash():
        out.append("저장소 문서가 바뀌었는데 오너용 아티팩트 「4DD 개발론」이 아직 갱신되지 않았습니다.")
    return out


def check():
    probs = problems()
    if probs:
        print("4DD 문서 동기화 검사 실패:", file=sys.stderr)
        for p in probs:
            print(f"  - {p}", file=sys.stderr)
        print("고치는 법: Claude에서 4dd-docs-sync 스킬을 따라 빌드하고 게시하세요.", file=sys.stderr)
        return 1
    print("4DD 문서 동기화: 맞음")
    return 0


def status():
    sync = load_sync()
    cur = source_hash()
    print(f"원본 해시      {cur[:12]}")
    print(f"마지막 게시    {sync.get('source_hash', '-')[:12]}  ({sync.get('published_at', '기록 없음')}, 버전 {sync.get('artifact_version', '-')})")
    try:
        man = json.loads((DIST / "manifest.json").read_text(encoding="utf-8"))
        print(f"마지막 빌드    {man['source_hash'][:12]}  ({man['built_at']})")
    except (OSError, ValueError, KeyError):
        print("마지막 빌드    없음")
    probs = problems()
    print("상태          " + ("맞음" if not probs else "어긋남"))
    for p in probs:
        print(f"  - {p}")
    return 0


# ---------------------------------------------------------------- Claude 훅

def read_hook_input():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}


def hook_stop():
    data = read_hook_input()
    probs = problems()
    if not probs:
        return 0
    reason = (
        "[4DD 문서 동기화] " + " ".join(probs) + "\n"
        "저장소 문서와 오너용 아티팩트는 항상 함께 맞춰 둡니다. 4dd-docs-sync 스킬 순서대로 하세요: "
        "① python3 docs-view/build.py build ② 결과를 한 번 확인 ③ Artifact 도구로 게시.\n" + publish_hint()
    )
    if data.get("stop_hook_active"):
        print(json.dumps({"systemMessage": "4DD 문서와 아티팩트가 아직 어긋나 있습니다. 커밋은 git 훅이 막습니다."}, ensure_ascii=False))
        return 0
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    return 0


def context_out(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))


def hook_post_artifact():
    data = read_hook_input()
    try:  # 진단용: 훅이 받은 입력을 남긴다 (dist/는 git에 올리지 않는다)
        DIST.mkdir(parents=True, exist_ok=True)
        (DIST / "last-post-artifact.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    ti = data.get("tool_input") or {}
    if ti.get("asset") or ti.get("action") not in (None, "", "publish"):
        return 0
    resp = data.get("tool_response")
    if isinstance(resp, str):
        try:
            resp = json.loads(resp)
        except ValueError:
            resp = {}
    if not isinstance(resp, dict):
        resp = {}
    base = pathlib.Path(data.get("cwd") or ROOT)
    fp = resp.get("path") or ti.get("file_path") or ""
    try:
        if not fp or (base / fp).resolve() != (DIST / "index.html").resolve():
            return 0
    except OSError:
        return 0
    if (resp.get("url") or "").rstrip("/") != ARTIFACT_URL:
        context_out("PostToolUse", f"[4DD 문서 동기화] 「4DD 개발론」({ARTIFACT_URL})이 아닌 곳에 게시됐습니다. sync.json에 기록하지 않았습니다. url을 넣어 다시 게시하세요.")
        return 0
    written = {f.get("path"): f.get("sha256") for f in resp.get("files_written") or []}
    wrong = []
    for name, _ in PAGES[1:]:
        local = DIST / name
        digest = hashlib.sha256(local.read_bytes()).hexdigest() if local.exists() else None
        if written.get(name) != digest:
            wrong.append(name)
    if wrong:
        context_out("PostToolUse", f"[4DD 문서 동기화] 함께 올라가야 할 페이지가 빠졌거나 빌드 결과와 다릅니다: {', '.join(wrong)}. files를 빠짐없이 넣어 다시 게시하세요. sync.json은 그대로 둡니다.")
        return 0
    try:
        man = json.loads((DIST / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        context_out("PostToolUse", "[4DD 문서 동기화] docs-view/dist/manifest.json이 없어 기록하지 않았습니다. 빌드부터 다시 하세요.")
        return 0
    cur = source_hash()
    if man.get("source_hash") != cur:
        context_out("PostToolUse", "[4DD 문서 동기화] 빌드한 뒤에 저장소 문서가 또 바뀌었습니다. 다시 빌드하고 게시하세요. sync.json은 그대로 둡니다.")
        return 0
    record = {
        "artifact_url": ARTIFACT_URL,
        "source_hash": cur,
        "published_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "artifact_version": f"{resp.get('seq', '?')} ({resp.get('version', '?')})",
        "pages": {"index.html": hashlib.sha256((DIST / "index.html").read_bytes()).hexdigest(), **written},
    }
    SYNC.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    context_out("PostToolUse", "[4DD 문서 동기화] 게시를 확인하고 docs-view/sync.json에 기록했습니다. 이 파일을 문서 변경과 함께 커밋하세요.")
    return 0


def hook_pre_edit():
    data = read_hook_input()
    fp = (data.get("tool_input") or {}).get("file_path") or ""
    try:
        target = pathlib.Path(fp).resolve() if fp else None
    except OSError:
        target = None
    if target and target == SYNC.resolve():
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "docs-view/sync.json은 손으로 고치지 않습니다. 아티팩트를 게시하면 훅이 자동으로 기록합니다 (4dd-docs-sync 스킬).",
        }}, ensure_ascii=False))
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "status"
    try:
        if cmd == "build":
            build()
            return 0
        if cmd == "check":
            return check()
        if cmd == "status":
            return status()
        if cmd == "hook-stop":
            return hook_stop()
        if cmd == "hook-post-artifact":
            return hook_post_artifact()
        if cmd == "hook-pre-edit":
            return hook_pre_edit()
    except BuildError as e:
        print(f"빌드 실패: {e}", file=sys.stderr)
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
