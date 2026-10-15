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
  const TRASH_W = 46;
  const TRASH_H = 46;
  const TRASH_PAD = 12;
  const TRASH_GRAB = 14;   // a drop zone wider than the icon: aiming at a 46px
                           // square with a 172px box under the hand is fiddly
  const DISMISS_MS = 8000;

  let board = { positions: {}, links: [], pinned: [] };
  let sessions = [];
  let api = null;
  let helpers = {};

  let dragging = null;   // { id, dx, dy, from, travelled }
  let overBin = false;   // the dragged node is hovering the trash
  // Ids the trash has just taken. A killed session can still be in the next
  // snapshot or two before its pid clears, and without this the node springs
  // back for a poll after being thrown away. An entry expires on its own, so a
  // session that survived the signal reappears rather than vanishing for good.
  const dismissed = new Map();
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
    const now = Date.now();
    for (const [id, until] of dismissed) if (now > until) dismissed.delete(id);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const ids = new Set(sessions.filter((s) => s.pid).map((s) => s.sessionId));
    for (const id of Object.keys(board.positions)) if (byId.has(id)) ids.add(id);
    for (const l of board.links) { if (byId.has(l.from)) ids.add(l.from); if (byId.has(l.to)) ids.add(l.to); }
    for (const id of dismissed.keys()) ids.delete(id);
    return [...ids].map((id) => byId.get(id)).filter(Boolean);
  }

  // The trash lives in the map's own coordinates, with a margin around it so a
  // 172px node dropped roughly there still lands.
  function binRect(w, h) {
    return {
      x: TRASH_PAD - TRASH_GRAB,
      y: h - TRASH_PAD - TRASH_H - TRASH_GRAB,
      w: TRASH_W + TRASH_GRAB * 2,
      h: TRASH_H + TRASH_GRAB * 2,
    };
  }

  function overBinAt(m) {
    const host = document.getElementById('map');
    if (!host) return false;
    const r = binRect(host.clientWidth, host.clientHeight);
    return m.x >= r.x && m.x <= r.x + r.w && m.y >= r.y && m.y <= r.y + r.h;
  }

  function paintBin() {
    const bin = document.getElementById('trash');
    if (!bin) return;
    bin.classList.toggle('armed', !!dragging);
    bin.classList.toggle('hot', !!overBin);
  }

  // Taking a node off the map is only ever about the board: positions and links
  // are ours to delete, the transcript on disk is not touched, and the session
  // stays resumable by id.
  function forget(id) {
    delete board.positions[id];
    for (const link of board.links) {
      if (link.from === id || link.to === id) delete answers[linkId(link.from, link.to)];
    }
    board.links = board.links.filter((link) => link.from !== id && link.to !== id);
    if (selected && selected.split('>').includes(id)) selected = null;
    save();
  }

  // A node dropped on the trash. A session that has already exited is just
  // cleared off the board; a live one is a real process, so main.js re-checks
  // the pid and asks before anything is signalled, and the node stays put if
  // the answer is no.
  function discard(id, home) {
    const toast = helpers.toast || (() => {});
    const s = sessions.find((x) => x.sessionId === id);
    // The drop left the node sitting on the bin. If it is not going anywhere,
    // put it back where the drag started rather than leaving it parked there.
    const putBack = () => {
      if (home) board.positions[id] = { x: home.x, y: home.y };
      save();
      render();
    };
    if (!s || !s.pid) {
      forget(id);
      render();
      toast(s ? 'took ' + s.title + ' off the board' : 'took it off the board');
      return;
    }
    api.endSession({ pid: s.pid, title: s.title }).then((res) => {
      if (!res.ok) { toast(res.reason || 'could not end that one'); putBack(); return; }
      if (!res.killed && res.reason === 'cancelled') { putBack(); return; }
      forget(id);
      dismissed.set(id, Date.now() + DISMISS_MS);
      render();
      if (res.killed) toast(res.slow ? s.title + ' is shutting down' : 'ended ' + s.title);
      else toast('took ' + s.title + ' off the board');
    });
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
      // A fourth line would overflow the node's fixed height, so token use
      // rides the node's own title instead of printed text, the same way the
      // port's title carries its own explanation rather than a label.
      const tokens = typeof tokenLine === 'function' ? tokenLine(n) : '';
      return `<div class="node is-${n.state}" data-id="${esc(n.sessionId)}" style="left:${p.x}px;top:${p.y}px"
          ${tokens ? `title="${esc(tokens)}"` : ''}>
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
      ${nodeHtml}
      <div id="trash" title="drag a session here to end it">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.2 5.5l.8 10.2a1.2 1.2 0 0 0 1.2 1.1h5.6a1.2 1.2 0 0 0 1.2-1.1l.8-10.2"/>
          <path d="M8.4 8.6v5M11.6 8.6v5"/>
        </svg>
        <span class="trash-cap">drop to end</span>
      </div>`;
    wire(host);
    paintBin();
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
        dragging = { id: node.dataset.id, dx: m.x - p.x, dy: m.y - p.y, travelled: 0, last: m, from: { x: p.x, y: p.y } };
        overBin = false;
        paintBin();
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
        // Tracked on the pointer rather than the node's box, so the hand says
        // where the drop goes and a wide node overlapping the bin does not.
        const hot = overBinAt(m);
        if (hot !== overBin) { overBin = hot; paintBin(); }
        node.classList.toggle('doomed', overBin);
        drawWiresOnly();
      };
      node.onpointerup = () => {
        if (!dragging) return;
        const id = dragging.id;
        const moved = dragging.travelled >= 4;
        const binned = overBin;
        const home = dragging.from;
        dragging = null;
        overBin = false;
        paintBin();
        if (binned) { lastTap = { id: null, at: 0 }; discard(id, home); return; }
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
      // A binned session is held off the map until its pid actually clears.
      // Once a snapshot agrees it is gone, the hold can be dropped early.
      if (dismissed.size) {
        const live = new Set(sessions.filter((x) => x.pid).map((x) => x.sessionId));
        for (const id of dismissed.keys()) if (!live.has(id)) dismissed.delete(id);
      }
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

    // Drag a node onto the trash through the real pointer handlers. main.js
    // refuses to signal anything while SB_TEST_TRASH is set, so this exercises
    // the whole gesture without ending a session.
    simulateTrash(match) {
      const host = document.getElementById('map');
      const nodes = [...host.querySelectorAll('.node')];
      const node = nodes.find((n) => (n.textContent || '').toLowerCase().includes(String(match).toLowerCase()));
      const bin = document.getElementById('trash');
      if (!node || !bin) return false;
      const nr = node.getBoundingClientRect();
      const br = bin.getBoundingClientRect();
      const cx = br.left + br.width / 2;
      const cy = br.top + br.height / 2;
      const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y });
      node.dispatchEvent(ev('pointerdown', nr.left + 30, nr.top + 20));
      const grabbed = !!dragging;
      // Two moves: the first clears the 4px dead zone, the second lands on the
      // bin, which is how a hand gets there too.
      node.dispatchEvent(ev('pointermove', (nr.left + 30 + cx) / 2, (nr.top + 20 + cy) / 2));
      node.dispatchEvent(ev('pointermove', cx, cy));
      const hot = bin.classList.contains('hot');
      node.dispatchEvent(ev('pointerup', cx, cy));
      const host2 = document.getElementById('map');
      return { grabbed, hot, bin: Math.round(cx) + ',' + Math.round(cy), map: host2.clientWidth + 'x' + host2.clientHeight };
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
