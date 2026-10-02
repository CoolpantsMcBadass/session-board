// The map view: sessions as nodes you place by hand, links you draw between them.
//
// A link is not decoration. Drawing A -> B says "B should see what A is doing",
// and firing it hands B a digest of A's recent conversation and brings back B's
// reply. Nothing can be pushed into a running session from outside, so the far
// end is always a fork: B's conversation is read, never written to.

(function () {
  const NODE_W = 172;
  const NODE_H = 60;
  const PAD = 16;

  let board = { positions: {}, links: [], pinned: [] };
  let sessions = [];
  let api = null;
  let helpers = {};

  let dragging = null;   // { id, dx, dy, from, travelled }
  let lastTap = { id: null, at: 0 };
  let linking = null;    // { fromId, x, y }
  let selected = null;   // link id
  const inFlight = new Set();
  const answers = Object.create(null);

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.saveBoard(board), 400);
  }

  function linkId(a, b) { return a + '>' + b; }

  // The map is inset inside the panel, so every pointer position has to be
  // converted from viewport coordinates into the map's own space.
  function local(ev) {
    const host = document.getElementById('map');
    const r = host.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // Nodes on the map: everything live, plus anything you have already placed or
  // linked, so a session you were talking to does not vanish when it exits.
  function nodeSet() {
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const ids = new Set(sessions.filter((s) => s.pid).map((s) => s.sessionId));
    for (const id of Object.keys(board.positions)) if (byId.has(id)) ids.add(id);
    for (const l of board.links) { if (byId.has(l.from)) ids.add(l.from); if (byId.has(l.to)) ids.add(l.to); }
    return [...ids].map((id) => byId.get(id)).filter(Boolean);
  }

  function place(nodes, w, h) {
    let i = 0;
    for (const n of nodes) {
      if (board.positions[n.sessionId]) continue;
      // Unplaced nodes land on a ring, which keeps them apart and makes it
      // obvious they have not been arranged yet.
      const count = Math.max(nodes.length, 3);
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const rx = Math.max(110, (w - NODE_W) / 2 - 40);
      const ry = Math.max(90, (h - NODE_H) / 2 - 60);
      board.positions[n.sessionId] = {
        x: Math.round(w / 2 - NODE_W / 2 + Math.cos(angle) * rx),
        y: Math.round(h / 2 - NODE_H / 2 + Math.sin(angle) * ry),
      };
      i++;
    }
  }

  function centre(id) {
    const p = board.positions[id] || { x: 0, y: 0 };
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
  }

  // Where the line from `from` crosses `to`'s border, so an arrowhead stops at
  // the edge of a node instead of disappearing underneath it.
  function border(from, to, pad = 5) {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    if (!dx && !dy) return to;
    const hw = NODE_W / 2 + pad;
    const hh = NODE_H / 2 + pad;
    const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: to.x + dx * s, y: to.y + dy * s };
  }

  function wireHtml() {
    const out = [];
    for (const l of board.links) {
      const ca = centre(l.from);
      const cb = centre(l.to);
      const a = border(cb, ca);
      const b = border(ca, cb);
      const id = linkId(l.from, l.to);
      const cls = [
        'edge',
        inFlight.has(id) ? 'busy' : '',
        selected === id ? 'sel' : '',
        answers[id] ? 'answered' : '',
      ].join(' ');
      const d = `M${a.x},${a.y} L${b.x},${b.y}`;
      // The fat transparent stroke is the click target; the visible one is thin
      // and ignores pointers, so a 1.6px line is still easy to grab.
      out.push(`<path class="edge-hit" data-link="${esc(id)}" d="${d}" />`);
      out.push(`<path class="${cls}" d="${d}" />`);
    }
    if (linking) {
      const ca = centre(linking.fromId);
      const a = border({ x: linking.x, y: linking.y }, ca);
      out.push(`<path class="edge temp" d="M${a.x},${a.y} L${linking.x},${linking.y}" />`);
    }
    return out.join('');
  }

  function bindWires(root) {
    for (const p of root.querySelectorAll('path[data-link]')) {
      p.onclick = (ev) => { ev.stopPropagation(); selected = p.dataset.link; render(); };
      p.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = p.dataset.link;
        board.links = board.links.filter((l) => linkId(l.from, l.to) !== id);
        delete answers[id];
        if (selected === id) selected = null;
        save();
        render();
      };
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render() {
    const host = document.getElementById('map');
    if (!host) return;
    const w = host.clientWidth || 780;
    const h = host.clientHeight || 560;
    const nodes = nodeSet();
    place(nodes, w, h);
    // The composer opening shrinks the map, so a node placed when it was taller
    // would sit underneath it. Keep every node inside the area that is visible now.
    for (const n of nodes) {
      const p = board.positions[n.sessionId];
      p.x = Math.max(0, Math.min(w - NODE_W, p.x));
      p.y = Math.max(0, Math.min(Math.max(0, h - NODE_H), p.y));
    }

    const nodeHtml = nodes.map((n) => {
      const p = board.positions[n.sessionId];
      return `<div class="node is-${n.state}" data-id="${esc(n.sessionId)}" style="left:${p.x}px;top:${p.y}px">
        <div class="node-top"><span class="dot ${n.state}"></span><span class="node-title">${esc(n.title)}</span></div>
        <div class="node-meta">${esc(n.state)}${n.cwdShort ? ' · ' + esc(n.cwdShort) : ''}</div>
        <div class="port" data-port="${esc(n.sessionId)}" title="drag to another session to link them"></div>
      </div>`;
    }).join('');

    host.innerHTML = `
      <svg class="wires" width="${w}" height="${h}">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
          </marker>
        </defs>
        ${wireHtml()}
      </svg>
      ${nodeHtml}`;
    wire(host);
    renderComposer();
  }

  function renderComposer() {
    const box = document.getElementById('composer');
    if (!box) return;
    if (!selected) { box.hidden = true; return; }
    const [from, to] = selected.split('>');
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) { box.hidden = true; return; }
    const ans = answers[selected];
    box.hidden = false;
    box.innerHTML = `
      <div class="comp-head">
        <strong>${esc(a.title)}</strong> → <strong>${esc(b.title)}</strong>
        <button data-comp="unlink">unlink</button>
        <button data-comp="close">close</button>
      </div>
      <textarea id="comp-q" placeholder="what should ${esc(b.title)} do with it? (default: what stands out)"></textarea>
      <div class="comp-actions">
        <button data-comp="send" ${inFlight.has(selected) ? 'disabled' : ''}>
          ${inFlight.has(selected) ? 'sending…' : 'send context'}
        </button>
      </div>
      ${ans ? `<div class="answer ${ans.err ? 'err' : ''}"><span class="who">${ans.err ? 'failed' : esc(b.title) + ' replied'}</span>${esc(ans.text)}</div>` : ''}`;

    for (const btn of box.querySelectorAll('button[data-comp]')) {
      btn.onclick = () => {
        const act = btn.dataset.comp;
        if (act === 'close') { selected = null; render(); }
        else if (act === 'unlink') {
          board.links = board.links.filter((l) => linkId(l.from, l.to) !== selected);
          delete answers[selected];
          selected = null; save(); render();
        } else if (act === 'send') fire(selected, a, b);
      };
    }
  }

  function openSession(sessionId) {
    const s = sessions.find((x) => x.sessionId === sessionId);
    const toast = helpers.toast || (() => {});
    if (!s) return;
    if (!s.tty) { toast('no terminal window for this one'); return; }
    api.focusSession(s.tty).then((res) => {
      if (!res.ok) toast(res.error || 'could not reach that window');
    });
  }

  function fire(id, a, b) {
    const q = document.getElementById('comp-q');
    const question = q ? q.value : '';
    inFlight.add(id);
    renderComposer();
    render();
    api.relay({
      fromId: a.sessionId, fromTitle: a.title,
      toId: b.sessionId, toCwd: b.cwd, question,
    }).then((res) => {
      inFlight.delete(id);
      answers[id] = res.ok ? { text: res.answer, err: false } : { text: res.error, err: true };
      render();
    });
  }

  function wire(host) {
    bindWires(host);

    for (const node of host.querySelectorAll('.node')) {
      node.onpointerdown = (ev) => {
        if (ev.target.classList.contains('port')) return;
        const p = board.positions[node.dataset.id];
        const m = local(ev);
        dragging = { id: node.dataset.id, dx: m.x - p.x, dy: m.y - p.y, travelled: 0, last: m };
        try { node.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
        ev.preventDefault();
      };
      node.onpointermove = (ev) => {
        if (!dragging || dragging.id !== node.dataset.id) return;
        const host2 = document.getElementById('map');
        const maxX = host2.clientWidth - NODE_W;
        const maxY = host2.clientHeight - NODE_H;
        const p = board.positions[dragging.id];
        const m = local(ev);
        // Measured on the pointer, not the node: a node pinned against an edge
        // stops moving while the hand keeps going, and that is still a drag.
        dragging.travelled += Math.abs(m.x - dragging.last.x) + Math.abs(m.y - dragging.last.y);
        dragging.last = m;
        p.x = Math.max(0, Math.min(maxX, Math.round(m.x - dragging.dx)));
        p.y = Math.max(0, Math.min(maxY, Math.round(m.y - dragging.dy)));
        node.style.left = p.x + 'px';
        node.style.top = p.y + 'px';
        drawWiresOnly();
      };
      node.onpointerup = () => {
        if (!dragging) return;
        const id = dragging.id;
        const moved = dragging.travelled >= 4;
        dragging = null;
        if (moved) { lastTap = { id: null, at: 0 }; save(); render(); return; }

        // A tap that went nowhere: a second one in quick succession opens the
        // terminal that session is running in.
        const now = Date.now();
        if (lastTap.id === id && now - lastTap.at < 400) {
          lastTap = { id: null, at: 0 };
          openSession(id);
        } else {
          lastTap = { id, at: now };
        }
        render();
      };
    }

    for (const port of host.querySelectorAll('.port')) {
      port.onpointerdown = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const m = local(ev);
        linking = { fromId: port.dataset.port, x: m.x, y: m.y };
        try { host.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      };
    }

    host.onpointermove = (ev) => {
      if (!linking) return;
      const m = local(ev);
      linking.x = m.x;
      linking.y = m.y;
      drawWiresOnly();
    };

    host.onpointerup = (ev) => {
      if (!linking) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const node = target && target.closest ? target.closest('.node') : null;
      const to = node && node.dataset.id;
      const from = linking.fromId;
      linking = null;
      if (to && to !== from && !board.links.some((l) => l.from === from && l.to === to)) {
        board.links.push({ from, to, at: Date.now() });
        selected = linkId(from, to);
        save();
      }
      render();
    };

    host.onclick = (ev) => {
      if (ev.target.id === 'map') { selected = null; render(); }
    };
  }

  // Redraw only the wires during a drag, so the nodes keep their event handlers
  // and the pointer capture is not torn out from under the gesture.
  function drawWiresOnly() {
    const host = document.getElementById('map');
    const svg = host && host.querySelector('svg.wires');
    if (!svg) return;
    svg.innerHTML = svg.querySelector('defs').outerHTML + wireHtml();
    bindWires(svg);
  }

  window.Canvas = {
    init(a, h) {
      api = a;
      helpers = h || {};
      api.loadBoard().then((b) => {
        board = Object.assign({ positions: {}, links: [], pinned: [] }, b || {});
        render();
      });
    },
    update(list) {
      sessions = list || [];
      if (dragging || linking) return;   // never redraw mid-gesture
      render();
    },
    busy() { return !!(dragging || linking); },
    linkCount() { return board.links.length; },

    // Tap a node the way a mouse would, so double-click detection is exercised.
    simulateNodeTap(match, times) {
      const host = document.getElementById('map');
      const nodes = [...host.querySelectorAll('.node')];
      const node = nodes.find((n) => (n.textContent || '').toLowerCase().includes(String(match).toLowerCase()));
      if (!node) return false;
      const r = node.getBoundingClientRect();
      const ev = (type) => new PointerEvent(type, {
        bubbles: true, pointerId: 1, clientX: r.left + 30, clientY: r.top + 20,
      });
      for (let i = 0; i < (times || 1); i++) {
        node.dispatchEvent(ev('pointerdown'));
        node.dispatchEvent(ev('pointerup'));
      }
      return true;
    },

    // Right-click the first wire, through the same handler a mouse would hit.
    simulateUnlink() {
      const hit = document.querySelector('#map path[data-link]');
      if (!hit) return false;
      hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true;
    },

    // Drives the real pointer handlers, so a test exercises the same path a
    // hand does rather than reaching past it into the data.
    simulateLink(fromMatch, toMatch) {
      const host = document.getElementById('map');
      const nodes = [...host.querySelectorAll('.node')];
      const find = (m) => nodes.find((n) => (n.textContent || '').toLowerCase().includes(String(m).toLowerCase()));
      const a = find(fromMatch);
      const b = find(toMatch);
      if (!a || !b) return false;
      const port = a.querySelector('.port');
      const pr = port.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const at = (x, y) => new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1 });
      port.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pr.left + 6, clientY: pr.top + 6, pointerId: 1 }));
      host.dispatchEvent(at(br.left + 60, br.top + 25));
      host.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: br.left + 60, clientY: br.top + 25, pointerId: 1 }));
      return true;
    },
  };
})();
