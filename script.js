(() => {
  'use strict';

  /* =========================================================
     CONFIGURAÇÃO
  ========================================================= */
  const MAX_PLAYERS = 16;
  const MIN_PLAYERS = 2;
  const PEER_PREFIX = 'arquivo-mental-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MISMATCH_DELAY = 1100;

  // STUN + TURN públicos: permitem jogar entre redes diferentes (PC no Wi-Fi, celular no 4G, etc.)
  const PEER_OPTS = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    },
  };

  const SIZES = [
    { total: 16, cols: 4, label: '16 cartas (8 pares)' },
    { total: 24, cols: 6, label: '24 cartas (12 pares)' },
    { total: 30, cols: 6, label: '30 cartas (15 pares)' },
    { total: 40, cols: 8, label: '40 cartas (20 pares)' },
  ];
  const DEFAULT_SIZE = 30;

  const EMOJIS = [
    '🐶', '🐱', '🦊', '🐼', '🐸', '🦁', '🐵', '🐙', '🦄', '🐢',
    '🦋', '🐝', '🐳', '🦉', '🐧', '🍎', '🍓', '🍉', '🍕', '🍩',
    '🎹', '🚀', '⚽', '🎸', '🌈', '⭐', '🎈', '🚗',
  ];

  /* =========================================================
     UTILITÁRIOS
  ========================================================= */
  const $ = (id) => document.getElementById(id);
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const playerColor = (i) => `hsl(${Math.round((i * 360) / MAX_PLAYERS + 20) % 360} 85% 60%)`;
  const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const sizeInfo = (total) => SIZES.find((s) => s.total === total) || SIZES[2];

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }

  function fillSizeSelect(sel) {
    sel.innerHTML = SIZES.map((s) => `<option value="${s.total}">${s.label}</option>`).join('');
    sel.value = String(DEFAULT_SIZE);
  }

  /* =========================================================
     ESTADO
  ========================================================= */
  // mode: 'local' | 'online' | null
  let mode = null;
  let isHost = false;
  let myId = null;
  let state = null;
  let mismatchTimer = null;

  // Rede
  let peer = null;
  let hostConn = null;       // (cliente) conexão com o anfitrião
  const conns = {};          // (anfitrião) id -> conexão

  function emptyState() {
    return { status: 'lobby', code: '', size: DEFAULT_SIZE, players: [], cards: [], turn: 0, open: [], busy: false, round: 0 };
  }

  /* =========================================================
     MOTOR DO JOGO (roda no aparelho local ou no anfitrião)
  ========================================================= */
  function startMatch() {
    const info = sizeInfo(state.size);
    const pairs = info.total / 2;
    const faces = shuffle(EMOJIS).slice(0, pairs);
    const deck = shuffle([...faces, ...faces]);
    state.cards = deck.map((e) => ({ e, s: 0, o: -1 })); // s: 0 virada p/ baixo, 1 aberta, 2 par feito
    state.players.forEach((p) => (p.score = 0));
    state.turn = firstOnline(0);
    state.open = [];
    state.busy = false;
    state.status = 'playing';
    state.round = (state.round || 0) + 1;
    commit();
  }

  function firstOnline(from) {
    const n = state.players.length;
    for (let k = 0; k < n; k++) {
      const i = (from + k) % n;
      if (state.players[i].online) return i;
    }
    return from;
  }

  function nextTurn() {
    state.turn = firstOnline((state.turn + 1) % state.players.length);
  }

  function hostFlip(pid, i) {
    if (state.status !== 'playing' || state.busy) return;
    const cur = state.players[state.turn];
    if (!cur || cur.id !== pid) return;
    const card = state.cards[i];
    if (!card || card.s !== 0 || state.open.length >= 2) return;

    card.s = 1;
    state.open.push(i);

    if (state.open.length === 2) {
      const [a, b] = state.open;
      if (state.cards[a].e === state.cards[b].e) {
        state.cards[a].s = state.cards[b].s = 2;
        state.cards[a].o = state.cards[b].o = state.turn;
        cur.score++;
        state.open = [];
        if (state.cards.every((c) => c.s === 2)) state.status = 'ended';
        commit();
        return;
      }
      state.busy = true;
      commit();
      clearTimeout(mismatchTimer);
      mismatchTimer = setTimeout(() => {
        state.open.forEach((k) => (state.cards[k].s = 0));
        state.open = [];
        state.busy = false;
        nextTurn();
        commit();
      }, MISMATCH_DELAY);
      return;
    }
    commit();
  }

  function hostPlayerLeft(pid) {
    if (!state) return;
    const idx = state.players.findIndex((p) => p.id === pid);
    if (idx < 0) return;
    delete conns[pid];

    if (state.status === 'lobby') {
      state.players.splice(idx, 1);
      commit();
      return;
    }

    state.players[idx].online = false;
    const stillOnline = state.players.filter((p) => p.online);
    if (stillOnline.length === 0) return;

    if (state.status === 'playing' && state.turn === idx && !state.busy) {
      state.open.forEach((k) => (state.cards[k].s = 0));
      state.open = [];
      nextTurn();
    }
    commit();
  }

  // Envia a versão pública do estado (cartas fechadas não revelam a figura)
  function publicState() {
    return {
      ...state,
      cards: state.cards.map((c) => (c.s === 0 ? { s: 0, o: -1 } : c)),
    };
  }

  function broadcast() {
    const msg = { t: 'state', s: publicState() };
    Object.values(conns).forEach((c) => { if (c.open) c.send(msg); });
  }

  function commit() {
    render();
    if (mode === 'online' && isHost) broadcast();
  }

  /* =========================================================
     MODO LOCAL
  ========================================================= */
  let localCount = 2;

  function renderLocalNames() {
    const box = $('local-names');
    const old = Array.from(box.querySelectorAll('input')).map((i) => i.value);
    box.innerHTML = '';
    for (let i = 0; i < localCount; i++) {
      const inp = document.createElement('input');
      inp.className = 'input';
      inp.maxLength = 14;
      inp.placeholder = `Jogador ${i + 1}`;
      inp.value = old[i] || '';
      box.appendChild(inp);
    }
    $('local-count').textContent = localCount;
    $('local-minus').disabled = localCount <= MIN_PLAYERS;
    $('local-plus').disabled = localCount >= MAX_PLAYERS;
  }

  function startLocal() {
    const names = Array.from($('local-names').querySelectorAll('input')).map((inp, i) => inp.value.trim() || `Jogador ${i + 1}`);
    mode = 'local';
    isHost = true;
    myId = null;
    state = emptyState();
    state.size = Number($('local-size').value);
    state.players = names.map((n, i) => ({ id: 'L' + i, name: n, score: 0, online: true }));
    show('screen-game');
    startMatch();
  }

  /* =========================================================
     MODO ONLINE (PeerJS: salas por código)
  ========================================================= */
  function myName() {
    const n = $('online-name').value.trim() || 'Jogador';
    try { localStorage.setItem('memoria-nome', n); } catch (e) {}
    return n.slice(0, 14);
  }

  function uniqueName(name) {
    let n = name, k = 2;
    while (state.players.some((p) => p.name === n)) n = `${name.slice(0, 11)} ${k++}`;
    return n;
  }

  function createRoom() {
    if (typeof Peer === 'undefined') return toast('Sem conexão com o servidor de salas.');
    const name = myName();
    mode = 'online';
    isHost = true;
    myId = 'host';
    $('btn-create').disabled = true;

    const attempt = (n) => {
      const code = randomCode();
      const p = new Peer(PEER_PREFIX + code, PEER_OPTS);
      p.on('open', () => {
        peer = p;
        state = emptyState();
        state.code = code;
        state.players = [{ id: 'host', name, score: 0, online: true }];
        $('btn-create').disabled = false;
        show('screen-lobby');
        render();
      });
      p.on('connection', onGuestConnection);
      p.on('error', (e) => {
        if (e.type === 'unavailable-id' && n < 5) { p.destroy(); return attempt(n + 1); }
        $('btn-create').disabled = false;
        toast('Não foi possível criar a sala. Tente de novo.');
        leaveToMenu();
      });
      p.on('disconnected', () => { try { p.reconnect(); } catch (e) {} });
    };
    attempt(0);
  }

  function onGuestConnection(conn) {
    conn.on('data', (m) => {
      if (!m || !state) return;
      if (m.t === 'join') {
        if (state.status !== 'lobby') return conn.send({ t: 'err', m: 'A partida já começou.' }), setTimeout(() => conn.close(), 300);
        if (state.players.length >= MAX_PLAYERS) return conn.send({ t: 'err', m: 'Sala cheia (máximo 16).' }), setTimeout(() => conn.close(), 300);
        conns[conn.peer] = conn;
        const nm = uniqueName(String(m.name || 'Jogador').slice(0, 14));
        state.players.push({ id: conn.peer, name: nm, score: 0, online: true });
        commit();
      } else if (m.t === 'flip' && Number.isInteger(m.i)) {
        hostFlip(conn.peer, m.i);
      }
    });
    conn.on('close', () => hostPlayerLeft(conn.peer));
    conn.on('error', () => hostPlayerLeft(conn.peer));
  }

  function joinRoom() {
    if (typeof Peer === 'undefined') return toast('Sem conexão com o servidor de salas.');
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 5) return toast('Digite o código de 5 letras da sala.');
    const name = myName();
    mode = 'online';
    isHost = false;
    $('btn-join').disabled = true;

    const fail = (msg) => {
      $('btn-join').disabled = false;
      toast(msg);
      leaveToMenu(false);
      show('screen-online');
    };

    const p = new Peer(undefined, PEER_OPTS);
    peer = p;
    const timeout = setTimeout(() => fail('Não foi possível conectar à sala.'), 15000);

    p.on('open', (id) => {
      myId = id;
      const c = p.connect(PEER_PREFIX + code, { reliable: true });
      hostConn = c;
      c.on('open', () => {
        clearTimeout(timeout);
        $('btn-join').disabled = false;
        c.send({ t: 'join', name });
      });
      c.on('data', (m) => {
        if (m.t === 'state') {
          const first = !state;
          state = m.s;
          if (first) show('screen-lobby');
          render();
        } else if (m.t === 'err') {
          clearTimeout(timeout);
          fail(m.m);
        }
      });
      c.on('close', () => {
        if (mode === 'online' && !isHost) {
          toast('O anfitrião saiu da sala.');
          leaveToMenu();
        }
      });
    });
    p.on('error', (e) => {
      clearTimeout(timeout);
      fail(e.type === 'peer-unavailable' ? 'Sala não encontrada.' : 'Erro de conexão.');
    });
  }

  function leaveToMenu(go = true) {
    clearTimeout(mismatchTimer);
    try { if (hostConn) hostConn.close(); } catch (e) {}
    Object.values(conns).forEach((c) => { try { c.close(); } catch (e) {} });
    for (const k in conns) delete conns[k];
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null; hostConn = null;
    mode = null; isHost = false; myId = null; state = null;
    $('modal-end').classList.add('hidden');
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    if (go) show('screen-menu');
  }

  /* =========================================================
     RENDERIZAÇÃO
  ========================================================= */
  function render() {
    if (!state) return;
    if (state.status === 'lobby') {
      $('modal-end').classList.add('hidden');
      renderLobby();
    } else renderGame();
  }

  function renderLobby() {
    if (!$('screen-lobby').classList.contains('active')) show('screen-lobby');
    $('room-code').textContent = state.code;
    $('lobby-count').textContent = `${state.players.length}/${MAX_PLAYERS}`;
    $('lobby-players').innerHTML = state.players.map((p, i) => `
      <li><span class="dot" style="--pc:${playerColor(i)}"></span>
      <span>${escapeHtml(p.name)}</span>
      ${p.id === 'host' ? '<span class="tag">Anfitrião</span>' : ''}</li>`).join('');

    $('lobby-host-opts').classList.toggle('hidden', !isHost);
    $('lobby-wait').classList.toggle('hidden', isHost);
    $('lobby-start').classList.toggle('hidden', !isHost);
    $('lobby-start').disabled = state.players.length < MIN_PLAYERS;
    $('lobby-start').textContent = state.players.length < MIN_PLAYERS ? 'Aguardando jogadores…' : 'Iniciar jogo';
    if (isHost) $('lobby-size').value = String(state.size);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function canPlay() {
    if (!state || state.status !== 'playing' || state.busy) return false;
    if (mode === 'local') return true;
    const cur = state.players[state.turn];
    return !!cur && cur.id === myId;
  }

  function renderGame() {
    if (!$('screen-game').classList.contains('active')) show('screen-game');

    const info = sizeInfo(state.size);
    const board = $('board');

    // Constrói o tabuleiro uma vez por partida
    if (board.dataset.round !== String(state.round) || board.children.length !== state.cards.length) {
      board.innerHTML = '';
      state.cards.forEach((_, i) => {
        const b = document.createElement('button');
        b.className = 'card';
        b.setAttribute('aria-label', `Carta ${i + 1}`);
        b.innerHTML = `<div class="inner"><div class="face back">${i + 1}</div><div class="face front"></div></div>`;
        b.addEventListener('click', () => onCardClick(i));
        board.appendChild(b);
      });
      board.dataset.round = String(state.round);
    }

    fitBoard();
    keepAwake();

    const playable = canPlay();
    state.cards.forEach((c, i) => {
      const el = board.children[i];
      if (!el) return;
      if (c.e) el.querySelector('.front').textContent = c.e;
      el.classList.toggle('up', c.s >= 1);
      el.classList.toggle('matched', c.s === 2);
      el.classList.toggle('locked', !playable);
      el.disabled = c.s !== 0 || !playable;
      if (c.s === 2 && c.o >= 0) el.style.setProperty('--oc', playerColor(c.o));
    });

    // Placar
    $('scoreboard').innerHTML = state.players.map((p, i) => `
      <div class="chip ${i === state.turn && state.status === 'playing' ? 'active' : ''} ${p.online ? '' : 'off'}" data-i="${i}">
        <span class="dot" style="--pc:${playerColor(i)}"></span>${escapeHtml(p.name)}<b>${p.score}</b>
      </div>`).join('');
    const act = $('scoreboard').querySelector('.chip.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

    // Banner de vez
    const cur = state.players[state.turn];
    const turn = $('turn-banner');
    const mine = mode === 'online' && cur && cur.id === myId;
    turn.classList.toggle('mine', mine && state.status === 'playing');
    turn.textContent = state.status === 'ended' ? 'Fim de jogo' : mine ? 'Sua vez!' : `Vez de ${cur ? cur.name : '—'}`;

    const room = $('game-room');
    room.classList.toggle('hidden', mode !== 'online');
    room.textContent = state.code;

    if (state.status === 'ended') showEnd();
  }

  function showEnd() {
    const sorted = state.players
      .map((p, i) => ({ ...p, i }))
      .sort((a, b) => b.score - a.score);
    const top = sorted[0].score;
    const winners = sorted.filter((p) => p.score === top);
    $('end-title').textContent = winners.length > 1
      ? `Empate: ${winners.map((w) => w.name).join(', ')}`
      : `${winners[0].name} venceu!`;
    $('end-ranking').innerHTML = sorted.map((p, k) => `
      <li class="${p.score === top ? 'first' : ''}">
        <span class="pos">${k + 1}º</span><span class="dot" style="--pc:${playerColor(p.i)}"></span>
        <span>${escapeHtml(p.name)}</span><span class="pts">${p.score} ${p.score === 1 ? 'par' : 'pares'}</span>
      </li>`).join('');

    const again = $('end-again');
    if (mode === 'online' && !isHost) {
      again.disabled = true;
      again.textContent = 'Aguardando o anfitrião…';
    } else {
      again.disabled = false;
      again.textContent = mode === 'online' ? 'Voltar para a sala' : 'Jogar de novo';
    }
    $('modal-end').classList.remove('hidden');
  }

  // Escolhe colunas e tamanho das cartas para o tabuleiro caber na tela (celular, tablet ou PC)
  function fitBoard() {
    if (!state || !state.cards.length) return;
    const wrap = document.querySelector('.board-wrap');
    const board = $('board');
    const n = state.cards.length;
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const rect = wrap.getBoundingClientRect();
    const availW = Math.max(200, wrap.clientWidth);
    const availH = Math.max(160, vh - rect.top - 18);
    const gap = availW < 520 ? 6 : 10;

    let best = { score: 0, w: 44, cols: 6 };
    for (let c = 3; c <= 10; c++) {
      const rows = Math.ceil(n / c);
      const w = Math.min((availW - gap * (c - 1)) / c, ((availH - gap * (rows - 1)) / rows) * 0.75);
      const score = n % c === 0 ? w : w * 0.93; // prefere linhas completas
      if (score > best.score) best = { score, w, cols: c };
    }
    board.style.setProperty('--cols', best.cols);
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--cw', Math.floor(Math.max(44, Math.min(150, best.w))) + 'px');
  }

  // Mantém a tela acesa durante a partida (evita o celular desconectar da sala)
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (!wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state && state.status === 'playing') keepAwake(); });

  let fitRaf = 0;
  const refit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(() => { if ($('screen-game').classList.contains('active')) fitBoard(); }); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', () => setTimeout(refit, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

  function onCardClick(i) {
    if (!canPlay()) return;
    if (mode === 'local') {
      hostFlip(state.players[state.turn].id, i);
    } else if (isHost) {
      hostFlip('host', i);
    } else if (hostConn && hostConn.open) {
      hostConn.send({ t: 'flip', i });
    }
  }

  /* =========================================================
     EVENTOS
  ========================================================= */
  $('btn-online').addEventListener('click', () => show('screen-online'));
  $('btn-local').addEventListener('click', () => { renderLocalNames(); show('screen-local'); });
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('screen-menu')));

  $('local-minus').addEventListener('click', () => { if (localCount > MIN_PLAYERS) { localCount--; renderLocalNames(); } });
  $('local-plus').addEventListener('click', () => { if (localCount < MAX_PLAYERS) { localCount++; renderLocalNames(); } });
  $('local-start').addEventListener('click', startLocal);

  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);
  $('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

  $('room-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      $('copy-hint').textContent = 'Código copiado!';
      setTimeout(() => ($('copy-hint').textContent = 'Toque no código para copiar'), 1800);
    } catch (e) { toast('Copie o código manualmente.'); }
  });

  $('lobby-size').addEventListener('change', (e) => {
    if (!isHost || !state) return;
    state.size = Number(e.target.value);
    commit();
  });
  $('lobby-start').addEventListener('click', () => {
    if (isHost && state.players.length >= MIN_PLAYERS) { startMatch(); }
  });
  $('lobby-leave').addEventListener('click', () => leaveToMenu());

  $('game-exit').addEventListener('click', () => {
    if (confirm('Sair da partida?')) leaveToMenu();
  });

  $('end-menu').addEventListener('click', () => leaveToMenu());
  $('end-again').addEventListener('click', () => {
    $('modal-end').classList.add('hidden');
    if (mode === 'local') {
      startMatch();
    } else if (isHost) {
      // volta para a sala com os jogadores que continuam conectados
      state.players = state.players.filter((p) => p.online);
      state.players.forEach((p) => (p.score = 0));
      state.status = 'lobby';
      state.cards = [];
      state.open = [];
      state.busy = false;
      commit();
    }
  });

  /* =========================================================
     INÍCIO
  ========================================================= */
  fillSizeSelect($('local-size'));
  fillSizeSelect($('lobby-size'));
  try { $('online-name').value = localStorage.getItem('memoria-nome') || ''; } catch (e) {}
  renderLocalNames();
  window.addEventListener('beforeunload', () => { try { if (peer) peer.destroy(); } catch (e) {} });
})();
