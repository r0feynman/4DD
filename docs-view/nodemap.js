/* 4DD 노드 맵 (오너가 고른 시안 나, 2026-11-23).
   위에 스프린트 고리(Stage 0 → 4 → 다음 스프린트)를 두고, 스테이지를 누르면 아래에 그 스테이지의 노드를 세로로 연다.
   - 굵은 선은 앞으로 가는 경로만 긋는다. 돌아가는 경로는 노드 옆 표의 ↩ 표지로 적는다.
   - 루프 상자는 용어집의 TDD 루프(data.loop)만 묶는다 (오너 결정 2026-11-18).
   - 노드를 누르면 그 노드로 들어오고 나가는 돌아가는 경로를 왼쪽에 둥근 곡선으로 그린다.
     곡선은 노드에서 띄워 시작하고 끝내며, 화살촉은 그대로 둔다 (오너 요청 2026-11-23).
   그림에 쓰는 말은 docs/glossary.md에 있는 말만 쓴다. 데이터는 build.py의 nodemap_data()가 원본에서 만든다. */
var fourddNodemapCount = 0;
function fourddNodemapMount(root) {
  'use strict';
  var D = JSON.parse(root.querySelector('.nm-data').textContent);
  var N = D.nodes, E = D.edges, S = D.stages, LOOP = D.loop.nodes;
  var MN = { sdd: 'SDD', bdd: 'BDD', tdd: 'TDD', fig: 'Figma', scrum: '스크럼' };
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 'nm' + (++fourddNodemapCount);
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cyc = root.querySelector('.nm-cyc'), map = root.querySelector('.nm-map'), cross = root.querySelector('.nm-cross');
  var sel = 0;

  function h(tag, attrs) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      var v = attrs[k];
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function sv(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ---------- 데이터 읽기 ----------
  function isSide(id) { return N[id].kind === '반복' || N[id].once; }
  function st(id) { return N[id].stage; }
  function trunk(s) { return S[s].nodes.filter(function (id) { return !isSide(id); }); }
  function gateOf(s) { return D.gates.filter(function (g) { return g.from === s; })[0]; }
  function gateLabel(g) { var t = trunk(g.from), last = t[t.length - 1]; return g.label.indexOf(last + ' ') === 0 ? g.label.slice(last.length + 1) : g.label; }
  function kindOf(e) {
    if (isSide(e.from)) return 'side';
    if (e.kind === 'next' || e.kind === 'aux') return 'fwd';
    if (e.label === '다음 스프린트') return 'spr';
    return st(e.to) < st(e.from) ? 'up' : 'ret';
  }
  function isBack(k) { return k === 'ret' || k === 'up' || k === 'spr'; }
  var RANK = { fwd: 0, gate: 1, side: 2, ret: 3, up: 4, spr: 5 };
  function outs(id) {
    var r = E.filter(function (e) { return e.from === id; }).map(function (e) { return { lab: e.label, to: e.to, k: kindOf(e) }; });
    if (!isSide(id)) {
      var s = st(id), t = trunk(s);
      if (t[t.length - 1] === id && gateOf(s)) r.push({ lab: gateLabel(gateOf(s)), to: trunk(s + 1)[0], k: 'gate' });
    }
    return r.sort(function (a, b) { return RANK[a.k] - RANK[b.k]; });
  }
  function ins(id) {
    var r = E.filter(function (e) { return e.to === id; }).map(function (e) { return { lab: e.label, from: e.from, k: kindOf(e) }; });
    if (!isSide(id)) {
      var s = st(id);
      if (s > 0 && trunk(s)[0] === id) { var g = gateOf(s - 1), tp = trunk(s - 1); r.push({ lab: gateLabel(g), from: tp[tp.length - 1], k: 'gate' }); }
    }
    return r.sort(function (a, b) { return RANK[a.k] - RANK[b.k]; });
  }

  // ---------- 스테이지 하나를 세로로 ----------
  function chip(id, k) {
    var cls = { ret: 'nm-ret', up: 'nm-up', spr: 'nm-spr' }[k] || 'nm-ref';
    var pre = (k === 'ret' || k === 'up') ? '↩ ' : (k === 'spr' ? '↻ ' : '');
    var b = h('button', { class: cls, type: 'button', 'data-go': id, title: id + ' ' + N[id].name }, pre + id);
    if (k === 'up') b.append(h('small', {}, 'Stage ' + st(id)));
    if (k === 'spr') b.append(h('small', {}, '다음 스프린트'));
    return b;
  }
  function decTable(id) {
    var o = outs(id).filter(function (x) { return x.k !== 'spr'; });
    var hasBack = o.some(function (x) { return isBack(x.k); });
    if (!hasBack && N[id].kind !== '판단') return null;
    var body = h('tbody');
    o.forEach(function (x) {
      var to;
      if (x.k === 'fwd') to = h('span', { class: 'nm-go' }, '↓ ' + x.to);
      else if (x.k === 'gate') to = h('span', { class: 'nm-go' }, '↓ Stage ' + st(x.to) + ' · ' + x.to);
      else to = chip(x.to, x.k);
      body.append(h('tr', {}, h('td', {}, x.lab || '다음'), h('td', {}, to)));
    });
    return h('table', { class: 'nm-dt' }, h('thead', {}, h('tr', {}, h('th', {}, '결과'), h('th', {}, '갈 곳'))), body);
  }
  function backIn(id) {
    var r = ins(id).filter(function (x) { return isBack(x.k); });
    if (!r.length) return null;
    return h('div', { class: 'nm-backin' }, '여기로 돌아옴:', r.map(function (x) {
      return h('button', { class: 'nm-ref', type: 'button', 'data-go': x.from, title: x.from + ' ' + (x.lab || '') }, x.from);
    }));
  }
  function sideCard(sid) {
    var n = N[sid], e = E.filter(function (x) { return x.from === sid; })[0];
    return h('button', { class: 'nm-side c-' + n.m, type: 'button', 'data-node': sid, 'data-side': sid },
      h('b', {}, sid + ' ', h('span', {}, n.short.replace(' (프로젝트당 1회)', ''))),
      h('small', {}, (n.once ? '프로젝트당 1회 노드' : '반복 노드') + ' · ' + e.label + ' → ' + e.to));
  }
  function row(id) {
    var n = N[id];
    var aside = h('div', { class: 'nm-aside' });
    E.filter(function (e) { return e.to === id && isSide(e.from); }).forEach(function (e) { aside.append(sideCard(e.from)); });
    add(aside, decTable(id));
    add(aside, backIn(id));
    return h('li', { class: 'nm-row c-' + n.m, 'data-id': id },
      h('span', { class: 'nm-dot' + (n.kind === '판단' ? ' nm-dec' : ''), 'data-dot': id }),
      h('div', { class: 'nm-ncol' },
        h('button', { class: 'nm-node', type: 'button', 'data-node': id, 'aria-expanded': 'false', title: n.name },
          h('b', {}, id), h('span', { class: 'nm-name' }, n.short), h('em', {}, MN[n.m])),
        h('div', { class: 'nm-relp', hidden: true })),
      aside);
  }
  function stageView(s) {
    var stg = S[s], t = trunk(s);
    var dec = stg.nodes.filter(function (id) { return N[id].kind === '판단'; }).length;
    var wrap = h('div', { class: 'nm-stage', 'data-stage': s },
      h('div', { class: 'nm-sh' }, h('span', { class: 'nm-sn' }, 'Stage ' + s), h('span', { class: 'nm-st' }, stg.title),
        h('span', { class: 'nm-sm' }, '노드 ' + stg.nodes.length + '개 · 판단 노드 ' + dec + '개')));
    var eb = s === 0
      ? h('button', { type: 'button', 'data-stage-go': S.length - 1 }, '← Stage ' + (S.length - 1) + '의 ' + trunk(S.length - 1).slice(-1)[0] + '에서 다음 스프린트로 시작')
      : h('button', { type: 'button', 'data-stage-go': s - 1 }, '← Stage ' + (s - 1) + '의 ' + gateOf(s - 1).label + ' 다음');
    wrap.append(h('div', { class: 'nm-entry' }, eb));
    var ol = h('ol', { class: 'nm-line' });
    for (var i = 0; i < t.length;) {
      if (t.slice(i, i + LOOP.length).join() === LOOP.join()) {
        var into = [];
        E.forEach(function (e) { if (LOOP.indexOf(e.to) >= 0 && LOOP.indexOf(e.from) < 0 && isBack(kindOf(e)) && into.indexOf(e.from) < 0) into.push(e.from); });
        ol.append(h('li', { class: 'nm-loop' },
          h('div', { class: 'nm-looptag' }, h('b', {}, D.loop.name), h('span', {}, LOOP.join(' → ')), into.length ? h('span', {}, '↩ ' + into.join(' · ') + '에서 돌아옴') : null),
          h('ol', { class: 'nm-line' }, LOOP.map(row))));
        i += LOOP.length;
      } else { ol.append(row(t[i])); i++; }
    }
    wrap.append(ol);
    var g = gateOf(s);
    if (g) {
      wrap.append(h('div', { class: 'nm-gate' }, h('span', { class: 'nm-pin' }, h('i')),
        h('button', { class: 'nm-gl', type: 'button', 'data-stage-go': s + 1 }, gateLabel(g) + ' → Stage ' + (s + 1) + ' ', h('small', {}, S[s + 1].title))));
    } else {
      var last = t[t.length - 1];
      var spr = E.filter(function (e) { return e.from === last && kindOf(e) === 'spr'; })[0];
      if (spr) wrap.append(h('div', { class: 'nm-gate nm-end' }, h('span', { class: 'nm-pin' }, h('i')),
        h('button', { class: 'nm-gl', type: 'button', 'data-go': spr.to }, '↻ ' + spr.label + ' · Stage ' + st(spr.to) + ' ' + spr.to + '부터')));
    }
    return wrap;
  }

  // ---------- 선 그리기 ----------
  var COLORS = { fg: 'var(--fg)', ret: 'var(--nm-ret)', up: 'var(--human)', spr: 'var(--muted)', mut: 'var(--muted)' };
  function defs(svg, p) {
    var d = sv('defs', {});
    Object.keys(COLORS).forEach(function (k) {
      var m = sv('marker', { id: p + '-' + k, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '10', markerHeight: '10', markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
      m.append(sv('path', { d: 'M0,1 L9,5 L0,9 z', style: 'fill:' + COLORS[k] }));
      d.append(m);
    });
    svg.append(d);
  }
  function overlay() {
    var svg = map.querySelector(':scope > svg.nm-ov');
    if (!svg) { svg = sv('svg', { class: 'nm-ov', 'aria-hidden': 'true' }); map.prepend(svg); }
    var R = map.getBoundingClientRect();
    if (!R.width) return;
    svg.setAttribute('width', R.width); svg.setAttribute('height', map.scrollHeight);
    svg.replaceChildren();
    var p = uid + 'm';
    defs(svg, p);
    function box(el) { var r = el.getBoundingClientRect(); return { x: r.left - R.left + r.width / 2, y: r.top - R.top + r.height / 2, l: r.left - R.left, r: r.right - R.left, t: r.top - R.top, b: r.bottom - R.top }; }
    // 굵은 선: 점과 스테이지 사이 연결을 차례로 잇는다
    var seq = map.querySelectorAll('.nm-dot, .nm-gate .nm-pin i');
    for (var i = 0; i + 1 < seq.length; i++) {
      var a = box(seq[i]), b = box(seq[i + 1]);
      svg.append(sv('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, style: 'stroke:var(--fg);stroke-width:4;stroke-linecap:round' }));
    }
    // 반복 노드·프로젝트당 1회 노드 → 대상 노드
    map.querySelectorAll('.nm-side').forEach(function (sc) {
      var node = sc.closest('.nm-row').querySelector('.nm-node');
      var s = box(sc), n = box(node), d;
      if (s.l > n.r) { var y = Math.max(n.t + 10, Math.min(n.b - 10, s.y)); d = 'M' + s.l + ',' + y + ' H' + (n.r + 2); }
      else { var x = Math.min(s.l + 22, n.r - 10); d = 'M' + x + ',' + s.t + ' V' + (n.b + 2); }
      svg.append(sv('path', { d: d, style: 'fill:none;stroke:var(--muted);stroke-width:1.6;stroke-dasharray:4 3', 'marker-end': 'url(#' + p + '-mut)' }));
    });
    // 누른 노드로 들어오고 나가는 돌아가는 경로: 점 왼쪽에 둥근 곡선. 짧은 경로는 작게, 긴 경로는 크게 휜다.
    var f = map.dataset.focus;
    if (!f) return;
    var arcs = [];
    E.forEach(function (e) {
      var k = kindOf(e);
      if (!isBack(k) || (e.from !== f && e.to !== f)) return;
      var A = map.querySelector('.nm-dot[data-dot="' + e.from + '"]'), B = map.querySelector('.nm-dot[data-dot="' + e.to + '"]');
      if (A && B) arcs.push({ a: box(A), b: box(B), k: k });
    });
    arcs.sort(function (u, v) { return Math.abs(u.a.y - u.b.y) - Math.abs(v.a.y - v.b.y); });
    arcs.forEach(function (c, j) {
      var x0 = c.a.x - 11 - 8;
      var maxW = Math.max(20, x0 - 6), minW = Math.min(22, maxW);
      var w = arcs.length > 1 ? minW + (maxW - minW) * j / (arcs.length - 1) : Math.min(maxW, 34);
      var k = w / 0.75;
      var d = 'M' + x0.toFixed(1) + ',' + c.a.y.toFixed(1) + ' C' + (x0 - k).toFixed(1) + ',' + c.a.y.toFixed(1) + ' ' + (x0 - k).toFixed(1) + ',' + c.b.y.toFixed(1) + ' ' + x0.toFixed(1) + ',' + c.b.y.toFixed(1);
      svg.append(sv('path', { d: d, style: 'fill:none;stroke:' + COLORS[c.k] + ';stroke-width:2.5;stroke-linecap:round' + (c.k === 'ret' ? '' : ';stroke-dasharray:6 4'), 'marker-end': 'url(#' + p + '-' + c.k + ')' }));
    });
  }

  // ---------- 노드 누르기 ----------
  function relItems(list, key) {
    return list.map(function (x) {
      return h('span', { class: 'nm-it' }, chip(x[key], isBack(x.k) ? x.k : 'ref'), x.lab ? h('em', {}, x.lab) : null);
    });
  }
  function clearFocus() {
    delete map.dataset.focus;
    map.classList.remove('nm-focusing');
    map.querySelectorAll('.nm-rel, .nm-cur').forEach(function (el) { el.classList.remove('nm-rel', 'nm-cur'); });
    map.querySelectorAll('.nm-relp').forEach(function (el) { el.hidden = true; el.replaceChildren(); });
    map.querySelectorAll('.nm-node[aria-expanded="true"]').forEach(function (el) { el.setAttribute('aria-expanded', 'false'); });
  }
  function focus(id, scroll) {
    var was = map.dataset.focus;
    clearFocus();
    if (was === id && !scroll) { overlay(); return; }
    map.dataset.focus = id;
    map.classList.add('nm-focusing');
    var rel = {}; rel[id] = 1;
    outs(id).forEach(function (x) { rel[x.to] = 1; });
    ins(id).forEach(function (x) { rel[x.from] = 1; });
    map.querySelectorAll('.nm-row').forEach(function (r) { if (rel[r.dataset.id]) r.classList.add('nm-rel'); });
    map.querySelectorAll('.nm-side').forEach(function (sc) { if (rel[sc.dataset.side]) sc.classList.add('nm-rel'); if (sc.dataset.side === id) sc.classList.add('nm-cur'); });
    var r = map.querySelector('.nm-row[data-id="' + id + '"]'), target = r;
    if (r) {
      r.classList.add('nm-cur');
      var n = N[id], p = r.querySelector('.nm-relp'), i = ins(id), o = outs(id);
      p.append(h('div', { class: 'nm-full' }, n.name, h('span', {}, ' · ' + MN[n.m] + ' · ' + n.kind + ' 노드')));
      if (i.length) p.append(h('div', { class: 'nm-rl' }, h('span', {}, '들어옴'), relItems(i, 'from')));
      if (o.length) p.append(h('div', { class: 'nm-rl' }, h('span', {}, '나감'), relItems(o, 'to')));
      p.hidden = false;
      r.querySelector('.nm-node').setAttribute('aria-expanded', 'true');
    } else {
      target = map.querySelector('.nm-side[data-side="' + id + '"]');
    }
    requestAnimationFrame(function () {
      overlay();
      if (scroll && target) {
        target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        target.classList.add('nm-flash'); setTimeout(function () { target.classList.remove('nm-flash'); }, 1100);
      }
    });
  }

  // ---------- 스프린트 고리 ----------
  function tile(s) {
    var stg = S[s];
    var dec = stg.nodes.filter(function (id) { return N[id].kind === '판단'; }).length;
    var dots = h('span', { class: 'nm-ctdots', 'aria-hidden': 'true' });
    stg.nodes.forEach(function (id) { dots.append(h('i', { class: 'c-' + N[id].m + (N[id].kind === '판단' ? ' nm-dec' : '') + (isSide(id) ? ' nm-sidedot' : '') })); });
    var extra = [];
    if (trunk(s).indexOf(LOOP[0]) >= 0) extra.push(D.loop.name);
    stg.nodes.filter(isSide).forEach(function (id) { extra.push(id + (N[id].once ? ' 프로젝트당 1회' : ' 매일')); });
    return h('button', { class: 'nm-ct', type: 'button', 'aria-pressed': String(s === sel), 'data-stage-go': s, 'aria-label': 'Stage ' + s + ' ' + stg.title + ', 노드 ' + stg.nodes.length + '개' },
      h('span', { class: 'nm-ctn' }, 'Stage ' + s), h('b', {}, stg.title), dots,
      h('span', { class: 'nm-ctm' }, '노드 ' + stg.nodes.length + ' · 판단 노드 ' + dec), extra.length ? h('span', { class: 'nm-ctm' }, extra.join(' · ')) : null);
  }
  function crossEdges(s) {
    var out = [], inn = [];
    E.forEach(function (e) {
      if (kindOf(e) !== 'up') return;
      if (st(e.from) === s) out.push(e); else if (st(e.to) === s) inn.push(e);
    });
    return { out: out, inn: inn };
  }
  function drawCycle() {
    cyc.replaceChildren();
    var W = cyc.clientWidth;
    if (!W) return;
    var narrow = W < 600, last = S.length - 1;
    cyc.classList.toggle('nm-narrow', narrow);
    var pos = [], tw, th, H, cx, cy, rx, ry;
    if (!narrow) {
      tw = 200; th = 112; H = 420; cx = W / 2; cy = H / 2; rx = W / 2 - tw / 2 - 6; ry = H / 2 - th / 2 - 6;
      for (var k = 0; k < S.length; k++) { var a = (-90 + 360 / S.length * k) * Math.PI / 180; pos.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    } else {
      tw = W - 2 * 46; th = 62; var gap = 44; H = S.length * th + last * gap + 12;
      for (var k2 = 0; k2 < S.length; k2++) pos.push([W / 2, 6 + th / 2 + k2 * (th + gap)]);
    }
    cyc.style.height = H + 'px';
    var svg = sv('svg', { width: W, height: H, 'aria-hidden': 'true' });
    defs(svg, uid + 'c');
    cyc.append(svg);
    function inTile(q, k, pad) { return Math.abs(q[0] - pos[k][0]) < tw / 2 + pad && Math.abs(q[1] - pos[k][1]) < th / 2 + pad; }
    function pathOf(pts) { return 'M' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' L'); }
    var pills = [];
    for (var g = 0; g < S.length; g++) {
      var nx = (g + 1) % S.length, lab = g < last ? gateOf(g).label : '다음 스프린트', d;
      if (!narrow) {
        var a0 = (-90 + 360 / S.length * g) * Math.PI / 180, a1 = a0 + 2 * Math.PI / S.length, pts = [];
        for (var t = 0; t <= 60; t++) {
          var aa = a0 + (a1 - a0) * t / 60, q = [cx + rx * Math.cos(aa), cy + ry * Math.sin(aa)];
          if (!inTile(q, g, 4) && !inTile(q, nx, 8)) pts.push(q);
        }
        if (!pts.length) continue;
        d = pathOf(pts);
        var mid = pts[Math.floor(pts.length / 2)];
        pills.push({ x: mid[0], y: mid[1], t: lab, spr: g === last });
      } else if (g < last) {
        d = 'M' + pos[g][0] + ',' + (pos[g][1] + th / 2 + 2) + ' V' + (pos[nx][1] - th / 2 - 7);
        pills.push({ x: pos[g][0], y: (pos[g][1] + pos[nx][1]) / 2, t: lab });
      } else {
        var xr = W - 18, xe = pos[0][0] + tw / 2;
        d = 'M' + (pos[last][0] + tw / 2) + ',' + pos[last][1] + ' H' + xr + ' V' + pos[0][1] + ' H' + (xe + 7);
        pills.push({ x: xr, y: (pos[0][1] + pos[last][1]) / 2, t: lab, spr: true, v: true });
      }
      svg.append(sv('path', { d: d, style: 'fill:none;stroke:var(--fg);stroke-width:' + (g === last ? '2.5;stroke-dasharray:7 4' : '3.5'), 'marker-end': 'url(#' + uid + 'c-fg)' }));
    }
    // 고른 스테이지와 다른 스테이지 사이에서 거꾸로 가는 경로
    var cr = crossEdges(sel), pairs = {};
    cr.out.concat(cr.inn).forEach(function (e) { pairs[st(e.from) + '>' + st(e.to)] = [st(e.from), st(e.to)]; });
    Object.keys(pairs).forEach(function (key, j) {
      var A = pos[pairs[key][0]], B = pos[pairs[key][1]], d2;
      if (!narrow) {
        var c = [(A[0] + B[0]) / 2 * 0.35 + cx * 0.65, (A[1] + B[1]) / 2 * 0.35 + cy * 0.65], pts2 = [];
        for (var t2 = 0; t2 <= 60; t2++) {
          var u = t2 / 60, q2 = [(1 - u) * (1 - u) * A[0] + 2 * (1 - u) * u * c[0] + u * u * B[0], (1 - u) * (1 - u) * A[1] + 2 * (1 - u) * u * c[1] + u * u * B[1]];
          if (!inTile(q2, pairs[key][0], 3) && !inTile(q2, pairs[key][1], 8)) pts2.push(q2);
        }
        if (!pts2.length) return;
        d2 = pathOf(pts2);
      } else {
        var xl = pos[0][0] - tw / 2, xg = Math.max(4, xl - 16 - j * 8);
        d2 = 'M' + xl + ',' + A[1] + ' C' + xg + ',' + A[1] + ' ' + xg + ',' + B[1] + ' ' + (xl - 7) + ',' + B[1];
      }
      svg.append(sv('path', { d: d2, style: 'fill:none;stroke:var(--human);stroke-width:2;stroke-dasharray:5 3', 'marker-end': 'url(#' + uid + 'c-up)' }));
    });
    if (!narrow) {
      [['스프린트 한 바퀴', 0, 16, 700, 'var(--fg)'], ['Stage 0 → ' + last + ' · ' + D.sprint, 22, 13, 400, 'var(--muted)']].forEach(function (x) {
        var tx = sv('text', { x: cx, y: cy - 4 + x[1], 'text-anchor': 'middle', style: 'font-family:var(--font-body);font-size:' + x[2] + 'px;font-weight:' + x[3] + ';fill:' + x[4] + ';paint-order:stroke;stroke:var(--bg);stroke-width:5px' });
        tx.textContent = x[0]; svg.append(tx);
      });
    }
    pills.forEach(function (pp) { cyc.append(h('span', { class: 'nm-pill' + (pp.spr ? ' nm-pill-spr' : '') + (pp.v ? ' nm-pill-v' : ''), style: 'left:' + pp.x + 'px;top:' + pp.y + 'px' }, pp.t)); });
    for (var s = 0; s < S.length; s++) {
      var el = tile(s);
      el.style.left = (pos[s][0] - tw / 2) + 'px'; el.style.top = (pos[s][1] - th / 2) + 'px';
      el.style.width = tw + 'px'; el.style.height = th + 'px';
      cyc.append(el);
    }
  }
  function crossBox(s) {
    var cr = crossEdges(s);
    cross.replaceChildren(h('div', { class: 'nm-cross-t' }, 'Stage ' + s + ' · ' + S[s].title + '에서 다른 스테이지로 오가는 경로'));
    function line(lbl, list, key) {
      if (!list.length) return;
      cross.append(h('div', { class: 'nm-rl' }, h('span', {}, lbl), list.map(function (e) {
        return h('span', { class: 'nm-it' }, h('button', { class: 'nm-ref', type: 'button', 'data-go': e[key], title: e.from + ' ' + e.label + ' → ' + e.to }, e.from + ' ' + e.label + ' →'), chip(e.to, 'up'));
      })));
    }
    line('앞 스테이지로 감', cr.out, 'from');
    line('뒤 스테이지에서 돌아옴', cr.inn, 'to');
    var spr = E.filter(function (e) { return kindOf(e) === 'spr' && (st(e.from) === s || st(e.to) === s); });
    if (spr.length) cross.append(h('div', { class: 'nm-rl' }, h('span', {}, '다음 스프린트'), spr.map(function (e) { return h('span', { class: 'nm-it' }, h('span', { class: 'nm-ref' }, e.from), '→', chip(e.to, 'spr')); })));
    if (!cr.out.length && !cr.inn.length && !spr.length) cross.append(h('div', { class: 'nm-rl' }, h('span', {}, '없음. 이 스테이지 안에서만 오갑니다.')));
  }

  // ---------- 고르기와 이벤트 ----------
  function selectStage(s, focusId) {
    sel = s;
    drawCycle();
    crossBox(s);
    map.replaceChildren(stageView(s));
    clearFocus();
    requestAnimationFrame(function () { overlay(); if (focusId) focus(focusId, true); });
  }
  function go(id) { if (st(id) !== sel) selectStage(st(id), id); else focus(id, true); }
  root.addEventListener('click', function (ev) {
    var g = ev.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    var sg = ev.target.closest('[data-stage-go]');
    if (sg) { selectStage(+sg.dataset.stageGo); if (!sg.classList.contains('nm-ct')) cyc.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' }); return; }
    var nd = ev.target.closest('[data-node]');
    if (nd) focus(nd.dataset.node, false);
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && map.dataset.focus) { clearFocus(); overlay(); } });
  function redraw() { drawCycle(); overlay(); }
  var lastW = 0;
  if (window.ResizeObserver) new ResizeObserver(function () { var w = root.clientWidth; if (w !== lastW) { lastW = w; redraw(); } }).observe(root);
  else window.addEventListener('resize', redraw);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
  selectStage(0);
}
