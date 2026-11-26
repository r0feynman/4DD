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
    ("slices.html", "구현 조각"),
    ("slice1.html", "조각 1"),
    ("slice2.html", "조각 2"),
    ("slice3.html", "조각 3"),
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

ART_COLOR = {
    "Story": "sdd", "Requirement": "sdd", "Task": "sdd", "Scenario": "bdd", "Frame": "fig", "Component": "fig",
    "Test": "tdd", "Commit": "tdd", "Feedback": "scrum", "DoneCondition": "scrum", "Decision": "human",
}


def onto_section(ctx, hd):
    """설계 ③ 자기 개선용 온톨로지: 기록 + 온톨로지 → 질의, 하네스 실행 타입, 기록 한 줄, 관계, 개발 산출물, 찾아내는 것."""
    sec = section(hd, "## 설계 ③")
    intro = sec.split("\n### ")[0]
    paras = [p.strip() for p in intro.split("\n\n") if p.strip() and not p.lstrip().startswith("-")]
    bb = bold_bullets(intro)
    if len(bb) < 4 or len(paras) < 2:
        raise BuildError("설계 ③ 첫머리에서 굵은 목록 넷(기록, 온톨로지, 하네스 실행, 개발 산출물)을 찾지 못했습니다")
    (rec_k, rec_v), (ont_k, ont_v), (run_k, run_v), (art_k, art_v) = bb[:4]

    def head_rest(text):
        head, _, rest = text.partition(". ")
        return (head + ("." if rest else ""), rest)

    def def_box(k, v, cls=""):
        h, rest = head_rest(v)
        return f'<div class="od-box{cls}"><span class="k">{inline(k)}</span><b>{inline(h)}</b>{f"<small>{inline(rest)}</small>" if rest else ""}</div>'

    find_sec = section(hd, "### 반복 실수와 비효율 찾기")
    find_lead = next((p for p in find_sec.strip().split("\n\n") if not p.lstrip().startswith(("|", "-"))), "")
    defs = (def_box(rec_k, rec_v) + '<span class="od-op" aria-hidden="true">+</span>' + def_box(ont_k, ont_v, " od-key")
            + '<span class="od-op" aria-hidden="true">→</span>'
            + f'<div class="od-box"><span class="k">질의</span><b>{chipify(ctx, find_lead)}</b></div>')

    def split_name(cell):
        m = re.match(r"^(.*?)\s*\(`(\w+)`(?:,\s*ID\s*`(\w+)`)?\)\s*$", cell.strip())
        if not m:
            raise BuildError(f"타입 이름 꼴(이름 (`Code`))이 아닙니다: {cell}")
        return m.group(1), m.group(2), m.group(3)

    def tag(text):
        t = text.strip()
        cls = " c-human" if "사람 개입" in t else (" ot-hub" if t == "노드 실행" else "")
        return f'<span class="otag{cls}">{inline(t)}</span>'

    type_sec = section(hd, "### 엔티티 타입")
    types = []
    for r in first_table(hd, "### 엔티티 타입"):
        name, code, _ = split_name(r["타입"])
        cls = "c-human" if code == "HumanIntervention" else ("ot-hub" if code == "NodeRun" else "c-plain")
        types.append(f'<div class="otype {cls}"><b>{inline(name)}</b><code>{esc(code)}</code><span class="d">{inline(r["뜻"])}</span><small>{inline(r["어디서 자동으로 뽑나"])}</small></div>')

    art_part = type_sec.split("**개발 산출물**", 1)
    if len(art_part) < 2:
        raise BuildError("엔티티 타입에서 「개발 산출물」 목록을 찾지 못했습니다")
    chips = []
    for line in art_part[1].splitlines():
        if line.startswith("- "):
            name, code, tid = split_name(line[2:])
            chips.append(f'<span class="ochip c-{ART_COLOR.get(code, "plain")}">{inline(name)}<small>{esc(code)}{" · " + esc(tid) if tid else ""}</small></span>')

    rels = "".join(
        f'<div class="orel"><span class="os">{"".join(tag(x) for x in r["주체"].split(", "))}</span>'
        f'<span class="ov">{inline(r["관계"])}<i aria-hidden="true">→</i></span>'
        f'<span class="oo">{"".join(tag(x) for x in r["대상"].split(", "))}</span></div>'
        for r in first_table(hd, "### 관계")
    )
    rel_part = section(hd, "### 관계").split("**개발 산출물**", 1)
    if len(rel_part) < 2:
        raise BuildError("관계에서 「개발 산출물」 목록을 찾지 못했습니다")
    art_rels = "".join(f"<li>{inline(l[2:])}</li>" for l in rel_part[1].splitlines() if l.startswith("- "))

    m = re.search(r"```json\n(.*?)```", section(hd, "### 하네스 실행 기록"), flags=re.S)
    if not m:
        raise BuildError("하네스 실행 기록의 json 예시를 찾지 못했습니다")
    dec, txt, pos, recs = json.JSONDecoder(), m.group(1), 0, []
    while True:
        while pos < len(txt) and txt[pos].isspace():
            pos += 1
        if pos >= len(txt):
            break
        obj, pos = dec.raw_decode(txt, pos)
        recs.append(obj)

    def rec_html(o):
        fields = []
        for k, v in o.items():
            if k == "type":
                continue
            if isinstance(v, list):
                v = " · ".join(f'{x.get("kind", "")} {x.get("id", "")}'.strip() if isinstance(x, dict) else str(x) for x in v)
            bad = " bad" if v in ("fail", "blocked") else ""
            fields.append(f'<span class="rf{bad}"><i>{esc(k)}</i>{esc(str(v))}</span>')
        return f'<div class="rec"><b>{esc(o.get("type", ""))}</b><div class="rfs">{"".join(fields)}</div></div>'

    rec_rules = "".join(
        f'<div class="card top c-plain"><span class="k">{inline(k)}</span><span class="d">{inline(v)}</span></div>'
        for k, v in bold_bullets(section(hd, "### 하네스 실행 기록"))
    )

    finds = []
    for r in first_table(hd, "### 반복 실수와 비효율 찾기"):
        k, _, d = r["찾아내는 것"].partition(":")
        c = "c-human" if "사람 개입" in k else "c-plain"
        finds.append(f'<div class="card top {c}"><span class="k">{inline(k.strip())}</span><span class="t">{chipify(ctx, r["질문"])}</span>{f"<span class=d>{inline(d.strip())}</span>" if d.strip() else ""}</div>')
    find_rules = "".join(f"<li>{chipify(ctx, l[2:])}</li>" for l in find_sec.splitlines() if l.startswith("- "))

    return f"""
<section>
  <h2>자기 개선용 온톨로지</h2>
  <p>{inline(paras[0])}</p>
  <div class="onto-def">{defs}</div>
  <h3 class="sub">{inline(run_k)}</h3>
  <p class="route-note">{inline(run_v)}</p>
  <div class="otypes">{"".join(types)}</div>
  <h3 class="sub">관계</h3>
  <div class="orels">{rels}</div>
  <h3 class="sub">원장에 남는 한 줄</h3>
  <div class="recs">{"".join(rec_html(o) for o in recs)}</div>
  <div class="cards onto-cards">{rec_rules}</div>
  <h3 class="sub">{inline(art_k)}</h3>
  <p class="route-note">{inline(art_v)} {chipify(ctx, paras[-1])}</p>
  <div class="ochips">{"".join(chips)}</div>
  <ul class="orel-art">{art_rels}</ul>
  <h3 class="sub">반복 실수와 비효율 찾기</h3>
  <div class="cards onto-cards">{"".join(finds)}</div>
  <ul class="onto-rules">{find_rules}</ul>
</section>"""


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
    onto_html = onto_section(ctx, hd)

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
{onto_html}
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


# ---------------------------------------------------------------- 페이지: 첫 구현 조각

WHO = {"하네스": "w-h", "작업 세션": "w-w", "리뷰 세션": "w-r", "사람": "w-p", "디자인 세션": "w-d", "분류": "w-r"}


# 구현 조각 명세(harness-slice*.md)는 같은 제목과 표 모양으로 씁니다. 아래 함수들이 두 페이지에서 같은 그림을 만듭니다.

def slice_intro(sd, what):
    paras = [p.strip() for p in sd.split("\n## ", 1)[0].split("\n\n") if p.strip() and not p.lstrip().startswith(("#", ">"))]
    if not paras:
        raise BuildError(f"{what} 명세의 첫 문단을 찾지 못했습니다")
    return paras[0]


def slice_table_cards(sd, heading, cols, label, cls):
    k, t, d = cols
    return "".join(
        f'<div class="card top {cls}"><span class="k">{inline(r[k])} · {label}</span><span class="t">{inline(r[t])}</span><span class="d">{inline(r[d])}</span></div>'
        for r in first_table(sd, heading)
    )


def slice_scope(ctx, sd):
    scope = dict(bold_bullets(section(sd, "## 범위")))
    if "하는 것" not in scope or "하지 않는 것" not in scope:
        raise BuildError("범위에서 「하는 것」, 「하지 않는 것」을 찾지 못했습니다")
    do_items = [x.strip().rstrip(".") for x in scope["하는 것"].split(", ")]
    not_text, _, not_note = scope["하지 않는 것"].partition(". ")
    not_items = [x.strip().rstrip(".") for x in not_text.split(", ")]
    return (
        f'<div class="scope-col scope-do"><h3>하는 것</h3><div class="sc-chips">{"".join(f"<span class=sc>{chipify(ctx, x)}</span>" for x in do_items)}</div></div>'
        f'<div class="scope-col scope-not"><h3>하지 않는 것</h3><div class="sc-chips">{"".join(f"<span class=sc>{chipify(ctx, x)}</span>" for x in not_items)}</div><small>{inline(not_note)}</small></div>'
    )


def slice_parts(ctx, sd, arrow):
    parts = first_table(sd, "## 구조")
    return (
        f'<div class="part part-main"><b>{inline(parts[0]["부분"])}</b><span>{inline(parts[0]["하는 일"])}</span></div>'
        f'<div class="part-arrow" aria-hidden="true">↓ {esc(arrow)}</div>'
        '<div class="parts">' + "".join(f'<div class="part"><b>{inline(r["부분"])}</b><span>{chipify(ctx, r["하는 일"])}</span></div>' for r in parts[1:]) + "</div>"
    )


def who_chips(who):
    names = [w.strip() for w in who.split("→")]
    return '<span class="who-sep" aria-hidden="true">→</span>'.join(f'<span class="who {WHO.get(w, "w-h")}">{esc(w)}</span>' for w in names)


def slice_nodes(ctx, sd):
    nrows = []
    for r in first_table(sd, "## 노드마다 누가 무엇을"):
        nid = r["노드"].strip()
        writes = r["고칠 수 있는 곳"].strip()
        wchips = "".join(f'<code class="wr">{esc(w.strip(" `"))}</code>' for w in writes.split(",")) if writes not in ("—", "") and "`" in writes else f'<span class="wr-none">{"고치는 곳 없음" if writes in ("—", "") else inline(writes)}</span>'
        fail = r["실패하면"].strip()
        # 노드 범위(N23~N25)는 칩 두 개로
        nchips = '<span class="who-sep" aria-hidden="true">~</span>'.join(idchip(ctx, x) for x in nid.split("~"))
        nrows.append(
            f'<div class="nrow"><div class="nhead">{nchips}{who_chips(r["누가"].strip())}</div>'
            f'<div class="nbody"><div class="nwr">{wchips}</div><div class="npass"><i>통과</i>{chipify(ctx, r["통과 조건"])}</div>'
            f'{"" if fail in ("—", "") else f"<div class=nfail><i>실패</i>{chipify(ctx, fail)}</div>"}</div></div>'
        )
    return nrows


def slice_pipeline(ctx, sd, heading):
    sec = section(sd, heading)
    m = re.search(r"```\n(.*?)```", sec, flags=re.S)
    if not m:
        raise BuildError(f"{heading[3:]} 그림을 찾지 못했습니다")
    layers = [x.strip() for x in m.group(1).strip().split("─▶")]
    notes = bold_bullets(sec)
    steps, key_name = [], ""
    for name in layers:
        short = name.split(" (")[0]
        note = next((v for k, v in notes if short in k or k in short), "")
        key = ""
        if "결정적" in note:
            key, key_name = " g-key", short
        if steps:
            steps.append('<span class="sep" aria-hidden="true">→</span>')
        steps.append(f'<div class="step c-plain{key}"><b>{inline(name)}</b><span class="do">{chipify(ctx, head_sentence(note))}</span></div>')
    return "".join(steps), key_name


def slice_cmds(sd):
    cmds_h, cmds_m = [], []
    for r in first_table(sd, "## `4dd` 명령"):
        card = (f'<div class="cmd"><code>{esc(r["명령"].strip("` ").replace(chr(92) + "|", "|"))}</code>'
                f'<span>{inline(r["하는 일"])}</span><small>{inline(r["종료 코드"])}</small></div>')
        (cmds_h if r["누가 부르나"].strip() in ("사람", "PO 창구") else cmds_m).append(card)
    return cmds_h, cmds_m


def slice_events(sd):
    return "".join(
        f'<div class="ev"><code>{esc(r["이벤트"].split(" (")[0].strip("` "))}</code>'
        f'{"<em class=ev-tag>" + esc(r["이벤트"].split(" (", 1)[1].rstrip(")")) + "</em>" if " (" in r["이벤트"] else ""}'
        f'<span>{inline(r["언제"])}</span><small>{inline(r["주요 필드"])}</small></div>'
        for r in first_table(sd, "## 원장 이벤트")
    )


def slice_human(sd):
    return "".join(
        f'<div class="less-row"><b>{inline(r["언제"])}</b><span class="before">{inline(r["사람이 하는 일"])}</span><span class="arrow" aria-hidden="true">→</span><span class="after">{inline(r["명령"])}</span></div>'
        for r in first_table(sd, "## 사람이 하는 일")
    )


def slice_steps(ctx, sd):
    steps = first_table(sd, "## 구현 순서")
    html_ = "".join(
        f'<div class="lstep c-plain"><span class="n">{esc(r["단계"])}</span><b>{inline(r["만드는 것"])}</b><span class="when">확인 · {chipify(ctx, r["확인"])}</span></div>'
        for r in steps
    )
    note = next((p.strip() for p in section(sd, "## 구현 순서").split("\n\n") if p.strip() and not p.lstrip().startswith("|")), "")
    return len(steps), html_, note


def slice_done(ctx, sd):
    # 체크한 것(- [x])은 채운 상자로 그린다
    done = [(l[3] == "x", l[6:].strip()) for l in section(sd, "## 완료 기준").splitlines() if l.startswith(("- [ ] ", "- [x] "))]
    return len(done), "".join(
        f'<li><span class="box{" on" if ok else ""}" aria-label="{"확인함" if ok else "남음"}"></span><span>{chipify(ctx, d)}</span></li>' for ok, d in done
    )


def split_top(text, sep=", "):
    """괄호 밖의 sep로만 나눈다 ("Figma 노드(N00F, N03W)"는 한 덩어리)."""
    out, cur, depth, i = [], "", 0, 0
    while i < len(text):
        ch = text[i]
        depth += ch in "(（"
        depth -= ch in ")）"
        if depth == 0 and text.startswith(sep, i):
            out.append(cur.strip())
            cur, i = "", i + len(sep)
            continue
        cur += ch
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


SLICE_STATUS = {"끝": "st-done", "구현": "st-spec", "명세": "st-spec", "계획": "st-plan"}


def load_slices():
    """하네스 설계의 「구현 조각」 표 (조각 목록의 유일한 원본)."""
    hd = read("docs/harness-design.md")
    sec = section(hd, "## 구현 조각")
    head, _, _ = sec.partition("\n### ")
    rows = first_table(hd, "## 구현 조각")
    for r in rows:
        r["n"] = int(r["조각"])
        r["status"] = r["상태"].split(" (")[0].strip()
        if r["status"] not in SLICE_STATUS:
            raise BuildError(f"구현 조각 {r['조각']}의 상태가 끝·명세·계획 가운데 하나가 아닙니다: {r['상태']}")
        st = r["스테이지"].replace(" ", "")
        r["stages"] = set(range(int(st.split("~")[0]), int(st.split("~")[1]) + 1)) if "~" in st else {int(x) for x in st.split(",")}
        r["page"] = f"slice{r['n']}.html" if (ROOT / "docs" / f"harness-slice{r['n']}.md").exists() else ""
    # 빈 곳 표(영역 | ID | 빈 곳)의 G마다 어느 조각이 채우나. 아무 조각도 채우지 않는 빈 곳이 있으면 멈춘다.
    gaps = [(r["ID"].strip(), r["빈 곳"].strip()) for r in first_table(hd, "## 빈 곳")]
    by_gap = {g: [r["n"] for r in rows if g in split_top(r["채우는 빈 곳"])] for g, _ in gaps}
    missing = [g for g, ns in by_gap.items() if not ns]
    if missing:
        raise BuildError(f"어느 구현 조각도 채우지 않는 빈 곳이 있습니다: {', '.join(missing)}")
    return {
        "rows": rows,
        "intro": next((p.strip() for p in head.split("\n\n") if p.strip() and not p.lstrip().startswith(("|", "-"))), ""),
        "notes": bold_bullets(head),
        "outside": bold_bullets(section(hd, "### 조각에 넣지 않은 것")),
        "finish": bold_bullets(section(hd, "### 조각을 모두 끝내면")),
        "gaps": gaps,
        "by_gap": by_gap,
        "source": sec,
    }


def status_chip(r):
    return f'<span class="st {SLICE_STATUS[r["status"]]}">{esc(r["상태"])}</span>'


def slice_nexts(ctx, current):
    return "".join(
        f'<div class="lstep c-plain"><span class="n">조각 {r["n"]} · {esc(r["이름"])}</span><span class="do">{chipify(ctx, r["하는 일"])}</span>{status_chip(r)}</div>'
        for r in load_slices()["rows"] if r["n"] > current
    )


def bold_bullets_nested(text):
    """'- **이름:** 내용'과 그 아래 들여 쓴 '  - 줄'을 (이름, 내용, [줄])로."""
    out = []
    for line in text.splitlines():
        m = re.match(r"^-\s+\*\*(.+?)\*\*\s*(.*)$", line)
        if m:
            out.append((m.group(1).rstrip(":："), m.group(2).strip(), []))
            continue
        s = re.match(r"^\s{2,}-\s+(.*)$", line)
        if s and out:
            out[-1][2].append(s.group(1).strip())
    return out


def verify_card(ctx, k, v, subs):
    """「구현하며 확인할 것」 카드. 제목 끝의 (확인함), (남음), (확인함, 날짜)를 칩으로, 들여 쓴 줄은 라벨 붙은 줄로."""
    st = re.search(r" [(](확인함|확인 중|남음)(?:, ?([^)]*))?[)]$", k)
    kind = st.group(1) if st else ("찾아 고친 것" if "찾아 고친" in k else "관찰")
    title = k[: st.start()] if st else k
    when = f' <span class="when">{esc(st.group(2))}</span>' if st and st.group(2) else ""
    rows = ""
    for s in subs:
        label, sep, rest = s.partition(": ")
        if sep and len(label) <= 24:
            rows += f'<div class="vrow"><b>{inline(label)}</b><span>{chipify(ctx, rest)}</span></div>'
        else:
            rows += f'<div class="vrow"><b></b><span>{chipify(ctx, s)}</span></div>'
    return (
        f'<div class="card top {"c-plain un" if kind == "남음" else "c-plain"}{" wide" if subs else ""}"><span class="k">{kind}</span>'
        f'<span class="t">{inline(title)}{when}</span><span class="d">{chipify(ctx, v)}</span>'
        + (f'<div class="vrows">{rows}</div>' if rows else "")
        + "</div>"
    )


def bullet_cards(ctx, text, label, cls_for=lambda k: "c-plain"):
    return "".join(
        f'<div class="card top {cls_for(k)}"><span class="k">{esc(label)}</span><span class="t">{inline(k)}</span><span class="d">{chipify(ctx, v)}</span></div>'
        for k, v in bold_bullets(text)
    )


def page_slice1(ctx):
    sd = read("docs/harness-slice1.md")
    lead = slice_intro(sd, "첫 구현 조각")
    decided = slice_table_cards(sd, "## 정한 것", ("항목", "결정", "이유"), "오너 결정", "c-human")
    scope_html = slice_scope(ctx, sd)
    parts_html = slice_parts(ctx, sd, "부리고 기록함")
    nrows = slice_nodes(ctx, sd)
    cmds_h, cmds_m = slice_cmds(sd)

    cmp_rows = first_table(sd, "## 도구 어댑터")
    keys = list(cmp_rows[0].keys())
    label_key = keys[0]
    cmp_html = "".join(
        f'<div class="cmp-row"><b>{inline(r[label_key])}</b><span><em>Claude</em>{inline(r["Claude"])}</span><span><em>Codex</em>{inline(r["Codex"])}</span></div>'
        for r in cmp_rows
    )

    gsteps, _ = slice_pipeline(ctx, sd, "## 잠금을 지키는 겹")

    cls_items = [l.split(". ", 1)[1] for l in section(sd, "## 실패 원인 분류").splitlines() if re.match(r"^\d+\. ", l)]
    cls_html = "".join(f'<div class="lstep c-plain"><span class="n">{i + 1}</span><span class="do">{chipify(ctx, t)}</span></div>' for i, t in enumerate(cls_items))

    events = slice_events(sd)
    human = slice_human(sd)
    n_steps, steps_html, order_note = slice_steps(ctx, sd)
    n_done, done_html = slice_done(ctx, sd)

    verify = "".join(
        f'<div class="card top c-plain"><span class="k">확인할 것</span><span class="t">{inline(k)}</span><span class="d">{inline(v)}</span></div>'
        for k, v in bold_bullets(section(sd, "## 구현하며 확인할 것"))
    )
    nexts = slice_nexts(ctx, 1)
    intro_paras = [lead]
    steps = range(n_steps)
    done = range(n_done)

    body = f"""
<header>
  <h1>첫 구현 조각</h1>
  <p class="lead">{inline(intro_paras[0])}</p>
  <div class="stats">
    <div class="stat"><b>{len(nrows)}</b><span>노드</span></div>
    <div class="stat"><b>{len(cmds_h) + len(cmds_m)}</b><span>4dd 명령</span></div>
    <div class="stat"><b>{len(steps)}</b><span>구현 단계</span></div>
    <div class="stat"><b>{len(done)}</b><span>완료 기준</span></div>
  </div>
</header>
<section>
  <h2>정한 것</h2>
  <div class="cards onto-cards">{decided}</div>
</section>
<section>
  <h2>범위</h2>
  <div class="scope">{scope_html}</div>
</section>
<section>
  <h2>구조</h2>
  <div class="structure">{parts_html}</div>
</section>
<section>
  <h2>노드마다 누가 무엇을</h2>
  <p>세 가지 모양이 누가 하는지를 나타냅니다: <span class="who w-h">하네스</span> <span class="who w-w">작업 세션</span> <span class="who w-r">리뷰 세션</span></p>
  <div class="nflow">{"".join(nrows)}</div>
</section>
<section>
  <h2>잠금을 지키는 겹</h2>
  <p>앞쪽일수록 빨리 막고, 굵은 테두리의 차례 뒤 변경 검사가 결정적인 겹입니다.</p>
  <div class="pipeline">{"".join(gsteps)}</div>
</section>
<section>
  <h2>실패 원인 분류</h2>
  <div class="lsteps">{cls_html}</div>
</section>
<section>
  <h2><code>4dd</code> 명령</h2>
  <h3 class="sub">사람이 부르는 것</h3>
  <div class="cmds">{"".join(cmds_h)}</div>
  <h3 class="sub">지휘 프로그램과 훅이 부르는 것</h3>
  <div class="cmds">{"".join(cmds_m)}</div>
</section>
<section>
  <h2>도구 어댑터</h2>
  <div class="cmp">{cmp_html}</div>
</section>
<section>
  <h2>원장 이벤트</h2>
  <p>한 줄에 하나, 추가만 합니다. 내용은 남기지 않고 ID, 해시, 숫자만 남깁니다.</p>
  <div class="evs">{events}</div>
</section>
<section>
  <h2>사람이 하는 일</h2>
  <div class="less">{human}</div>
</section>
<section>
  <h2>구현 순서</h2>
  <div class="lsteps">{steps_html}</div>
  <p class="route-note">{inline(order_note)}</p>
</section>
<section>
  <h2>완료 기준</h2>
  <ul class="chk">{done_html}</ul>
</section>
<section>
  <h2>구현하며 확인할 것</h2>
  <div class="cards onto-cards">{verify}</div>
</section>
<section>
  <h2>다음 조각</h2>
  <div class="lsteps">{nexts}</div>
  <p class="route-note">전체 조각과 순서는 <a href="slices.html">구현 조각</a> 페이지 한 곳에 있습니다.</p>
</section>
{source_block("docs/harness-slice1.md")}
"""
    return subpage(ctx, "slice1.html", "4DD 첫 구현 조각", body)


def page_slice2(ctx):
    rel = "docs/harness-slice2.md"
    sd = read(rel)
    lead = slice_intro(sd, "조각 2")
    decided = slice_table_cards(sd, "## 정한 것", ("항목", "결정", "이유"), "오너 결정", "c-human")
    decided_note = next((p.strip() for p in section(sd, "## 정한 것").split("\n\n") if p.strip() and not p.lstrip().startswith("|")), "")
    scope_html = slice_scope(ctx, sd)
    parts_html = slice_parts(ctx, sd, "명령으로 옮김")
    nrows = slice_nodes(ctx, sd)
    n_human = sum(1 for r in first_table(sd, "## 노드마다 누가 무엇을") if "사람" in r["누가"])
    node_notes = bullet_cards(ctx, section(sd, "## 노드마다 누가 무엇을").split("\n### ", 1)[0], "노드 규칙")
    files = bullet_cards(ctx, section(sd, "### 파일 형식"), "파일 형식")

    po_sec = section(sd, "## PO 창구")
    po_intro = next((p.strip() for p in po_sec.split("\n\n") if p.strip() and not re.match(r"^\d+\. ", p.strip())), "")
    po_steps = [l.split(". ", 1)[1] for l in po_sec.splitlines() if re.match(r"^\d+\. ", l)]
    if not po_steps:
        raise BuildError("PO 창구의 순서를 찾지 못했습니다")
    po_html = "".join(f'<div class="lstep c-human"><span class="n">{i + 1}</span><span class="do">{chipify(ctx, t)}</span></div>' for i, t in enumerate(po_steps))
    po_rule = next((p.strip() for p in po_sec.split("\n### ", 1)[0].split("\n\n") if p.strip().startswith("창구는")), "")
    review_cards = bullet_cards(ctx, section(sd, "### 검토 페이지"), "검토 페이지")
    approve_cards = bullet_cards(ctx, section(sd, "### 승인과 되돌림"), "승인과 되돌림", lambda k: "c-human" if k.endswith("승인") else "c-plain")

    gsteps, key_name = slice_pipeline(ctx, sd, "## 승인을 지키는 겹")
    guard_note = next((p.strip() for p in section(sd, "## 승인을 지키는 겹").split("\n\n") if p.strip().startswith("창구가")), "")
    packet_cards = bullet_cards(ctx, section(sd, "## 스테이지 패킷과 기준 해시"), "패킷과 기준 해시")
    ids = "".join(
        f'<div class="card top c-plain"><span class="d">{chipify(ctx, l.strip()[2:])}</span></div>'
        for l in section(sd, "## 프로젝트 전체 ID").splitlines() if l.startswith("- ")
    )

    fx_sec = section(sd, "## 시험 프로젝트")
    quote = re.search(r"^\s*>\s*(.+)$", fx_sec, flags=re.M)
    if not quote:
        raise BuildError("시험 프로젝트의 스토리 인용을 찾지 못했습니다")
    fixture = bullet_cards(ctx, fx_sec, "시험 프로젝트")
    story_note = next((p.strip() for p in fx_sec.split("\n\n") if p.strip().startswith("로그인의")), "")

    cmds_h, cmds_m = slice_cmds(sd)
    events = slice_events(sd)
    ev_notes = bullet_cards(ctx, section(sd, "## 원장 이벤트"), "원장")
    queries = "".join(
        f'<div class="card top c-plain"><span class="k">질의</span><span class="t">{chipify(ctx, r["질문"])}</span><span class="d">{chipify(ctx, r["찾아내는 것"])}</span></div>'
        for r in first_table(sd, "## 보고서에 더하는 것")
    )
    human = slice_human(sd)
    n_steps, steps_html, order_note = slice_steps(ctx, sd)
    n_done, done_html = slice_done(ctx, sd)
    nexts = slice_nexts(ctx, 2)
    cmds_n = len(cmds_h) + len(cmds_m)
    verify = ""
    if "## 구현하며 확인할 것" in sd:
        verify = "".join(verify_card(ctx, k, v, subs) for k, v, subs in bold_bullets_nested(section(sd, "## 구현하며 확인할 것")))

    body = f"""
<header>
  <h1>조각 2: Stage 0·1과 사람 승인</h1>
  <p class="lead">{inline(lead)}</p>
  <div class="stats">
    <div class="stat"><b>{len(nrows)}</b><span>노드</span></div>
    <div class="stat"><b>{n_human}</b><span>사람이 하는 노드</span></div>
    <div class="stat"><b>{cmds_n}</b><span>4dd 명령</span></div>
    <div class="stat"><b>{n_steps}</b><span>구현 단계</span></div>
    <div class="stat"><b>{n_done}</b><span>완료 기준</span></div>
  </div>
</header>
<section>
  <h2>정한 것</h2>
  <div class="cards onto-cards">{decided}</div>
  <p class="route-note">{inline(decided_note)}</p>
</section>
<section>
  <h2>범위</h2>
  <div class="scope">{scope_html}</div>
</section>
<section>
  <h2>구조</h2>
  <div class="structure">{parts_html}</div>
</section>
<section>
  <h2>노드마다 누가 무엇을</h2>
  <p>네 가지 모양이 누가 하는지를 나타냅니다: <span class="who w-p">사람</span> <span class="who w-h">하네스</span> <span class="who w-w">작업 세션</span> <span class="who w-r">리뷰 세션</span></p>
  <div class="nflow">{"".join(nrows)}</div>
  <div class="cards onto-cards">{node_notes}</div>
  <h3 class="sub">파일 형식</h3>
  <div class="cards onto-cards">{files}</div>
</section>
<section>
  <h2>PO 창구</h2>
  <p>{inline(po_intro)}</p>
  <div class="lsteps">{po_html}</div>
  <p class="route-note">{inline(po_rule)}</p>
  <h3 class="sub">검토 페이지</h3>
  <div class="cards onto-cards">{review_cards}</div>
  <h3 class="sub">승인과 되돌림</h3>
  <div class="cards onto-cards">{approve_cards}</div>
</section>
<section>
  <h2>승인을 지키는 겹</h2>
  <p>앞쪽일수록 빨리 막고, 굵은 테두리의 {esc(key_name)}가 결정적인 겹입니다.</p>
  <div class="pipeline">{gsteps}</div>
  <p class="route-note">{inline(guard_note)}</p>
</section>
<section>
  <h2>스테이지 패킷과 기준 해시</h2>
  <div class="cards onto-cards">{packet_cards}</div>
</section>
<section>
  <h2>프로젝트 전체 ID</h2>
  <div class="cards onto-cards">{ids}</div>
</section>
<section>
  <h2>시험 프로젝트</h2>
  <blockquote class="story-quote"><span class="k">PO의 스토리</span>{inline(quote.group(1))}</blockquote>
  <p class="route-note">{inline(story_note)}</p>
  <div class="cards onto-cards">{fixture}</div>
</section>
<section>
  <h2><code>4dd</code> 명령</h2>
  <h3 class="sub">사람과 PO 창구가 부르는 것</h3>
  <div class="cmds">{"".join(cmds_h)}</div>
  <h3 class="sub">지휘 프로그램, 관문, 훅이 부르는 것</h3>
  <div class="cmds">{"".join(cmds_m)}</div>
</section>
<section>
  <h2>원장 이벤트</h2>
  <p>첫 조각의 이벤트 9종에 둘을 더하고 셋을 넓힙니다. 내용은 남기지 않고 ID, 해시, 숫자만 남깁니다.</p>
  <div class="evs">{events}</div>
  <div class="cards onto-cards">{ev_notes}</div>
</section>
<section>
  <h2>보고서에 더하는 것</h2>
  <div class="cards onto-cards">{queries}</div>
</section>
<section>
  <h2>사람이 하는 일</h2>
  <div class="less">{human}</div>
</section>
<section>
  <h2>구현 순서</h2>
  <div class="lsteps">{steps_html}</div>
  <p class="route-note">{inline(order_note)}</p>
</section>
<section>
  <h2>완료 기준</h2>
  <ul class="chk">{done_html}</ul>
</section>
{f'<section><h2>구현하며 확인할 것</h2><div class="cards onto-cards">{verify}</div></section>' if verify else ""}
<section>
  <h2>다음 조각</h2>
  <div class="lsteps">{nexts}</div>
  <p class="route-note">전체 조각과 순서는 <a href="slices.html">구현 조각</a> 페이지 한 곳에 있습니다.</p>
</section>
{source_block(rel)}
"""
    return subpage(ctx, "slice2.html", "4DD 조각 2", body)


def page_slice3(ctx):
    rel = "docs/harness-slice3.md"
    sd = read(rel)
    lead = slice_intro(sd, "조각 3")
    # 정한 것: 날짜가 붙은 줄은 오너 결정(노랑), 나머지는 명세의 제안(점선)
    decided = "".join(
        f'<div class="card top {"c-human" if "(20" in r["항목"] else "c-plain prop"}"><span class="k">{"오너 결정" if "(20" in r["항목"] else "제안 · 승인 전"}</span>'
        f'<span class="t">{inline(re.sub(r" [(]20[0-9-]+[)]$", "", r["항목"]))}</span><span class="d">{chipify(ctx, r["결정"])}</span></div>'
        for r in first_table(sd, "## 정한 것")
    )
    n_owner = sum(1 for r in first_table(sd, "## 정한 것") if "(20" in r["항목"])
    n_prop = len(first_table(sd, "## 정한 것")) - n_owner
    scope_html = slice_scope(ctx, sd)
    parts_html = slice_parts(ctx, sd, "부림")
    nrows = slice_nodes(ctx, sd)
    n_fig = sum(1 for r in first_table(sd, "## 노드마다 누가 무엇을") if any(ctx["by_id"].get(x.strip(), {}).get("method") == "fig" for x in r["노드"].split("~")))
    node_notes = bullet_cards(ctx, section(sd, "## 노드마다 누가 무엇을").split("\n### ", 1)[0], "노드 규칙")
    files = bullet_cards(ctx, section(sd, "### 파일 형식"), "파일 형식")
    yaml_cards = bullet_cards(ctx, section(sd, "### `nodes.yaml`에 더하는 것"), "nodes.yaml")
    instr_cards = bullet_cards(ctx, section(sd, "### 노드 지시문"), "노드 지시문")

    dsteps, key_name = slice_pipeline(ctx, sd, "## 디자인이 흐르는 길")

    # Figma 도구 행렬: 노드마다 쓰기·읽기 점
    fsec = section(sd, "## Figma를 쓰는 세션")
    frows = first_table(sd, "## Figma를 쓰는 세션")
    fm = '<div class="fm-n"></div><div class="fm-h">쓰기</div><div class="fm-h">읽기</div>' + "".join(
        f'<div class="fm-n">{chipify(ctx, r["노드"])}<small>{inline(r["이유"])}</small></div>'
        f'<div class="fm-c"><span class="dot{" fig-on" if "쓰기" in r["Figma 도구"] else ""}" aria-label="쓰기 {"됨" if "쓰기" in r["Figma 도구"] else "안 됨"}"></span></div>'
        f'<div class="fm-c"><span class="dot{" on" if ("읽기" in r["Figma 도구"]) else ""}" aria-label="읽기 {"됨" if "읽기" in r["Figma 도구"] else "안 됨"}"></span></div>'
        for r in frows
    )
    fnotes = bullet_cards(ctx, fsec, "도구별")

    visual = bullet_cards(ctx, section(sd, "## 화면 비교 (N26F)"), "화면 비교")
    fx_sec = section(sd, "## 시험 프로젝트")
    fixture = bullet_cards(ctx, fx_sec, "시험 프로젝트")
    tree = re.search(r"```\n(.*?)```", fx_sec, flags=re.S)
    cmds_h, cmds_m = slice_cmds(sd)
    events = slice_events(sd)
    ev_intro = next((p.strip() for p in section(sd, "## 원장 이벤트").split("\n\n") if p.strip() and not p.lstrip().startswith("|")), "")
    queries = "".join(
        f'<div class="card top c-plain"><span class="k">질의</span><span class="t">{inline(r["질의"])}</span><span class="d">{inline(r["무엇을 보나"])}</span></div>'
        for r in first_table(sd, "## 보고서에 더하는 것")
    )
    human = slice_human(sd)
    n_steps, steps_html, order_note = slice_steps(ctx, sd)
    n_done, done_html = slice_done(ctx, sd)
    nexts = slice_nexts(ctx, 3)
    verify = "".join(verify_card(ctx, k, v, subs) for k, v, subs in bold_bullets_nested(section(sd, "## 구현하며 확인할 것")))
    # 자기 검토: 찾은 문제(차수별)와 남은 위험
    review = ""
    for title in ("1차 검토에서 찾은 문제와 바꾼 점", "2차 검토에서 찾은 문제와 바꾼 점"):
        review += f'<h3 class="sub">{esc(title)}</h3><div class="cards onto-cards">{bullet_cards(ctx, section(sd, "### " + title), title[:2] + " 검토")}</div>'
    risks = "".join(f"<li>{chipify(ctx, l[2:].strip())}</li>" for l in section(sd, "### 남은 위험").splitlines() if l.startswith("- "))

    body = f"""
<header>
  <h1>조각 3: 모바일·웹과 Figma</h1>
  <p class="lead">{inline(lead)}</p>
  <div class="stats">
    <div class="stat"><b>{len(nrows)}</b><span>노드 줄</span></div>
    <div class="stat"><b>{n_fig}</b><span>Figma 노드</span></div>
    <div class="stat"><b>{n_owner}</b><span>정한 것{f" (+ 제안 {n_prop})" if n_prop else ""}</span></div>
    <div class="stat"><b>{n_steps}</b><span>구현 단계</span></div>
    <div class="stat"><b>{n_done}</b><span>완료 기준</span></div>
  </div>
</header>
<section>
  <h2>정한 것</h2>
  <p>{"노랑은 오너가 정한 것, 점선은 이 명세의 제안(승인 전)입니다." if n_prop else "모두 오너가 정했습니다. 아래쪽 일곱 장은 명세가 제안하고 오너가 그대로 승인한 것입니다."}</p>
  <div class="cards onto-cards">{decided}</div>
</section>
<section>
  <h2>범위</h2>
  <div class="scope">{scope_html}</div>
</section>
<section>
  <h2>디자인이 흐르는 길</h2>
  <p>굵은 테두리의 {esc(key_name)}이 결정적인 자리입니다. 그 뒤로는 Figma를 누가 고쳐도 기준이 바뀌지 않습니다.</p>
  <div class="pipeline">{dsteps}</div>
</section>
<section>
  <h2>구조</h2>
  <div class="structure">{parts_html}</div>
</section>
<section>
  <h2>노드마다 누가 무엇을</h2>
  <p>다섯 가지 모양이 누가 하는지를 나타냅니다: <span class="who w-p">사람</span> <span class="who w-h">하네스</span> <span class="who w-w">작업 세션</span> <span class="who w-d">디자인 세션</span> <span class="who w-r">리뷰 세션</span></p>
  <div class="nflow">{"".join(nrows)}</div>
  <div class="cards onto-cards">{node_notes}</div>
  <h3 class="sub">파일 형식</h3>
  <div class="cards onto-cards">{files}</div>
  <h3 class="sub">nodes.yaml에 더하는 것</h3>
  <div class="cards onto-cards">{yaml_cards}</div>
  <h3 class="sub">노드 지시문</h3>
  <div class="cards onto-cards">{instr_cards}</div>
</section>
<section>
  <h2>Figma를 쓰는 세션</h2>
  <p>분홍 점은 Figma에 쓸 수 있는 노드, 검은 점은 읽을 수 있는 노드입니다. 구현 세션은 쓰기 점이 없습니다.</p>
  <div class="fmatrix">{fm}</div>
  <div class="cards onto-cards">{fnotes}</div>
</section>
<section>
  <h2>화면 비교 (N26F)</h2>
  <div class="cards onto-cards">{visual}</div>
</section>
<section>
  <h2>시험 프로젝트</h2>
  <div class="cards onto-cards">{fixture}</div>
  {f'<pre class="tree">{esc(tree.group(1).rstrip())}</pre>' if tree else ""}
</section>
<section>
  <h2><code>4dd</code> 명령</h2>
  <h3 class="sub">사람과 PO 창구가 부르는 것</h3>
  <div class="cmds">{"".join(cmds_h)}</div>
  <h3 class="sub">지휘 프로그램, 관문이 부르는 것</h3>
  <div class="cmds">{"".join(cmds_m)}</div>
</section>
<section>
  <h2>원장 이벤트</h2>
  <p>{inline(ev_intro)}</p>
  <div class="evs">{events}</div>
</section>
<section>
  <h2>보고서에 더하는 것</h2>
  <div class="cards onto-cards">{queries}</div>
</section>
<section>
  <h2>사람이 하는 일</h2>
  <div class="less">{human}</div>
</section>
<section>
  <h2>구현 순서</h2>
  <div class="lsteps">{steps_html}</div>
  <p class="route-note">{inline(order_note)}</p>
</section>
<section>
  <h2>완료 기준</h2>
  <ul class="chk">{done_html}</ul>
</section>
<section>
  <h2>구현하며 확인할 것</h2>
  <div class="cards onto-cards">{verify}</div>
</section>
<section>
  <h2>자기 검토</h2>
  {review}
  <h3 class="sub">남은 위험</h3>
  <ul class="chk risks">{risks}</ul>
</section>
<section>
  <h2>다음 조각</h2>
  <div class="lsteps">{nexts}</div>
  <p class="route-note">전체 조각과 순서는 <a href="slices.html">구현 조각</a> 페이지 한 곳에 있습니다.</p>
</section>
{source_block(rel)}
"""
    return subpage(ctx, "slice3.html", "4DD 조각 3", body)


def spec_link(r):
    if r["page"]:
        return f'<a class="sc-link" href="{r["page"]}">명세 보기 →</a>'
    return '<span class="sc-nolink">명세는 앞 조각이 끝난 뒤에 씀</span>'


def page_slices(ctx):
    sl = load_slices()
    rows = sl["rows"]
    n = len(rows)
    count = {k: sum(1 for r in rows if r["status"] == k) for k in SLICE_STATUS}

    # 조각이 쌓이며 되는 것: 막대가 조각마다 한 칸씩 길어진다
    ladder = "".join(
        f'<div class="lad-row {SLICE_STATUS[r["status"]]}">'
        f'<div class="lad-head"><b>조각 {r["n"]}</b>{status_chip(r)}</div>'
        f'<div class="lad-bar" aria-hidden="true"><span style="width:{round((i + 1) / n * 100)}%"></span></div>'
        f'<div class="lad-text"><span class="lad-name">{esc(r["이름"])}</span>{chipify(ctx, r["끝나면"])}</div></div>'
        for i, r in enumerate(rows)
    )

    # 스테이지 덮기: 조각마다 어느 스테이지를 다루나 (점)
    head = '<div class="sm-cell sm-h"></div>' + "".join(f'<div class="sm-cell sm-h">Stage {s}</div>' for s in range(5))
    body_cells = "".join(
        f'<div class="sm-cell sm-name"><b>조각 {r["n"]}</b><span>{esc(r["이름"])}</span><small>{esc(r["작업 유형"])}</small></div>'
        + "".join(f'<div class="sm-cell"><span class="dot{" on" if s in r["stages"] else ""}" aria-label="Stage {s} {"다룸" if s in r["stages"] else "안 다룸"}"></span></div>' for s in range(5))
        for r in rows
    )
    matrix = f'<div class="smatrix">{head}{body_cells}</div>'

    cards = "".join(
        f'<article class="slice-card {SLICE_STATUS[r["status"]]}">'
        f'<header><span class="sc-n">{r["n"]}</span><div><b>{esc(r["이름"])}</b>{status_chip(r)}</div></header>'
        f'<div class="sc-sec"><i>하는 일</i><div class="sc-chips">{"".join(f"<span class=sc>{chipify(ctx, x)}</span>" for x in split_top(r["하는 일"]))}</div></div>'
        f'<div class="sc-sec"><i>채우는 빈 곳</i><div class="sc-chips">{"".join(f"<span class=gtag>{esc(g)}</span>" for g in split_top(r["채우는 빈 곳"]))}</div></div>'
        f'<div class="sc-sec"><i>끝나면</i><span>{chipify(ctx, r["끝나면"])}</span></div>'
        f'{spec_link(r)}</article>'
        for r in rows
    )
    notes = "".join(
        f'<div class="card top c-plain"><span class="t">{inline(k)}</span><span class="d">{chipify(ctx, v)}</span></div>'
        for k, v in sl["notes"]
    )
    outside = "".join(
        f'<div class="card top c-plain un"><span class="k">조각 밖 · 보류</span><span class="t">{inline(k)}</span><span class="d">{chipify(ctx, v)}</span></div>'
        for k, v in sl["outside"]
    )
    finish = "".join(
        f'<div class="card top c-plain"><span class="t">{inline(k)}</span><span class="d">{chipify(ctx, v)}</span></div>'
        for k, v in sl["finish"]
    )
    status_of = {r["n"]: r["status"] for r in rows}
    gap_cells = "".join(
        f'<div class="gcell{" g-done" if any(status_of[x] == "끝" for x in sl["by_gap"][g]) else ""}">'
        f'<div class="gc-head"><b>{esc(g)}</b><span class="gc-ns">'
        + "".join(f'<span class="gn {SLICE_STATUS[status_of[x]]}">{x}</span>' for x in sl["by_gap"][g])
        + f'</span></div><span class="gc-d">{inline(desc)}</span></div>'
        for g, desc in sl["gaps"]
    )
    n_gap_done = sum(1 for g, _ in sl["gaps"] if any(status_of[x] == "끝" for x in sl["by_gap"][g]))

    body = f"""
<header>
  <h1>구현 조각</h1>
  <p class="lead">{inline(sl["intro"])}</p>
  <div class="stats">
    <div class="stat"><b>{n}</b><span>조각</span></div>
    <div class="stat"><b>{count["끝"]}</b><span>끝</span></div>
    <div class="stat"><b>{count["구현"] + count["명세"]}</b><span>진행 중</span></div>
    <div class="stat"><b>{count["계획"]}</b><span>계획</span></div>
    <div class="stat"><b>{len(sl["gaps"])}</b><span>채울 빈 곳 (G)</span></div>
  </div>
</header>
<section>
  <h2>조각이 쌓이며 되는 것</h2>
  <p>막대는 조각을 하나씩 붙일 때마다 하네스가 할 수 있는 일이 늘어나는 것을 나타냅니다. 진한 것이 끝난 조각입니다.</p>
  <div class="ladder">{ladder}</div>
</section>
<section>
  <h2>조각마다 다루는 스테이지</h2>
  <p>채운 점이 그 조각에서 하네스가 돌리는 스테이지입니다.</p>
  {matrix}
</section>
<section>
  <h2>조각마다 하는 일</h2>
  <div class="slice-cards">{cards}</div>
  <div class="cards onto-cards">{notes}</div>
</section>
<section>
  <h2>빈 곳 {len(sl["gaps"])}개를 어느 조각이 채우나</h2>
  <p>하네스 설계가 찾은 빈 곳마다, 그것을 채우는 조각 번호를 붙였습니다. 진한 번호가 끝난 조각입니다. 조각 1이 끝나 손댄 빈 곳은 {n_gap_done}개입니다. 모든 빈 곳에 조각이 하나 이상 있어야 이 페이지가 만들어집니다.</p>
  <div class="ggrid">{gap_cells}</div>
</section>
<section>
  <h2>조각을 모두 끝내면</h2>
  <div class="cards onto-cards">{finish}</div>
  <div class="cards onto-cards">{outside}</div>
</section>
<section><details class="source"><summary>원문 펼쳐 보기 · <code>docs/harness-design.md</code> 「구현 조각」</summary><div class="md">{render_md(sl["source"])}</div></details></section>
"""
    return subpage(ctx, "slices.html", "4DD 구현 조각", body)


def head_sentence(text):
    head, _, rest = text.partition(". ")
    return head + ("." if rest else "")


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
      <a class="card top c-scrum" href="slices.html"><span class="k">구현 조각</span><span class="t">조각 {wf["slices"]}개 · 끝난 조각 {wf["slices_done"]}개</span><span class="d">하네스를 처음부터 끝까지 도는 작은 범위로 잘라 차례로 만듦</span></a>
      <a class="card top c-tdd" href="slice1.html"><span class="k">첫 구현 조각</span><span class="t">구현 {wf["slice_steps"]}단계 · 완료 기준 {wf["slice_done"]}개</span><span class="d">백엔드 기능 하나가 Stage 2를 사람 손 없이 도는 것부터</span></a>
      <a class="card top c-human" href="slice2.html"><span class="k">조각 2 · 끝</span><span class="t">구현 {wf["slice2_steps"]}단계 · 사람이 하는 노드 {wf["slice2_human"]}개</span><span class="d">PO가 채팅으로 스토리를 적고 검토 페이지에서 승인하면 Stage 0부터 끝까지</span></a>
      <a class="card top c-fig" href="slice3.html"><span class="k">조각 3 · 명세</span><span class="t">구현 {wf["slice3_steps"]}단계 · Figma 노드 4개</span><span class="d">Figma 디자인부터 앱 구현과 화면 비교까지, Android와 웹에서</span></a>
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
        "slice_steps": len(first_table(read("docs/harness-slice1.md"), "## 구현 순서")),
        "slice_done": sum(1 for l in section(read("docs/harness-slice1.md"), "## 완료 기준").splitlines() if l.startswith("- [ ] ")),
        "slice2_steps": len(first_table(read("docs/harness-slice2.md"), "## 구현 순서")),
        "slice3_steps": len(first_table(read("docs/harness-slice3.md"), "## 구현 순서")),
        "slices": len(load_slices()["rows"]),
        "slices_done": sum(1 for r in load_slices()["rows"] if r["status"] == "끝"),
        "slice2_human": sum(1 for r in first_table(read("docs/harness-slice2.md"), "## 노드마다 누가 무엇을") if "사람" in r["누가"]),
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
        "slices.html": page_slices(ctx),
        "slice1.html": page_slice1(ctx),
        "slice2.html": page_slice2(ctx),
        "slice3.html": page_slice3(ctx),
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
