// シンプルな静的ファイルサーバー + SSE ブロードキャスト
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// boardId -> Set of response objects (SSE connections)
const clients = new Map();

// In-memory board state and timers (Node-only mode)
// boardId -> { score: number, timer: number, timerRunning: boolean }
const boardsState = new Map();
const intervals = new Map(); // boardId -> intervalId

function ensureBoardState(boardId) {
  if (!boardsState.has(boardId)) boardsState.set(boardId, { score: 0, timer: 0, timerRunning: false, submissions: [] });
  return boardsState.get(boardId);
}

function sendEventToBoard(boardId, payload) {
  const list = clients.get(boardId);
  if (!list) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of list) {
    try { res.write(data); } catch (e) { /* ignore write errors */ }
  }
}

function broadcastAll(payload) {
  for (const boardId of clients.keys()) sendEventToBoard(boardId, payload);
}

function broadcastState(boardId) {
  const s = ensureBoardState(boardId);
  // compute top score and ranking (top 10)
  const ranking = (s.submissions || []).slice().sort((a,b) => b.score - a.score).slice(0,10);
  const topScore = ranking.length ? ranking[0].score : (s.score || 0);
  sendEventToBoard(boardId, { timer: s.timer, score: s.score, topScore, ranking });
}

function startTimer(boardId) {
  const s = ensureBoardState(boardId);
  if (s.timerRunning) return;
  s.timerRunning = true;
  console.log(`[timer] start board=${boardId} timer=${s.timer}`);
  // clear existing interval if any
  if (intervals.has(boardId)) clearInterval(intervals.get(boardId));
  const id = setInterval(() => {
    const st = ensureBoardState(boardId);
    if (!st.timerRunning) { clearInterval(id); intervals.delete(boardId); return; }
    if ((st.timer || 0) <= 0) {
      st.timer = 0;
      st.timerRunning = false;
      clearInterval(id);
      intervals.delete(boardId);
      console.log(`[timer] finished board=${boardId}`);
      broadcastState(boardId);
      return;
    }
    st.timer = Math.max(0, (st.timer || 0) - 1);
    // log each tick for debugging
    console.log(`[timer] tick board=${boardId} timer=${st.timer}`);
    broadcastState(boardId);
  }, 1000);
  intervals.set(boardId, id);
}

function stopTimer(boardId) {
  const s = ensureBoardState(boardId);
  s.timerRunning = false;
  console.log(`[timer] stop board=${boardId}`);
  if (intervals.has(boardId)) {
    clearInterval(intervals.get(boardId));
    intervals.delete(boardId);
  }
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^\.\./, '');
  let filePath = path.join(process.cwd(), safePath);
  // default to index.html for root
  if (filePath === process.cwd() + path.sep) filePath = path.join(process.cwd(), 'index.html');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS and OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' });
    res.end();
    return;
  }

  if (pathname === '/events' && req.method === 'GET') {
    const board = parsed.query.board || '1';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');

    if (!clients.has(board)) clients.set(board, new Set());
    const set = clients.get(board);
  set.add(res);
  console.log(`[sse] connect board=${board} clients=${set.size}`);

    // send current state immediately
    try { const s = ensureBoardState(board); res.write(`data: ${JSON.stringify({ timer: s.timer, score: s.score })}\n\n`); } catch(e){}

    req.on('close', () => { set.delete(res); console.log(`[sse] disconnect board=${board} clients=${set.size}`); if (set.size===0) clients.delete(board); });
    return;
  }

  if (pathname === '/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.connection.destroy(); });
    req.on('end', () => {
    try {
      const obj = JSON.parse(body || '{}');
      console.log('[update] received', obj);
        // handle update actions and mutate server-side state
        // obj: { boards: ['1','2'] | null(for all), action: 'start'|'stop'|'reset'|'delta'|'set'|'broadcast', timer, delta, score }
        const boards = obj.boards == null ? null : (Array.isArray(obj.boards) ? obj.boards : [obj.boards]);

        const applyTo = (targetBoards, fn) => {
          if (targetBoards == null) {
            // apply to all known boards; if none exist, apply to board '1'
            const keys = Array.from(new Set([...boardsState.keys(), ...clients.keys()]));
            if (keys.length === 0) keys.push('1');
            keys.forEach(b => fn(b));
          } else {
            targetBoards.forEach(b => fn(b));
          }
        };

        if (obj.action === 'start') {
          const secs = Number(obj.timer) || 0;
          applyTo(boards, (b) => {
            const s = ensureBoardState(b);
            // do NOT overwrite the live timer value when pressing start
            // but remember the configured timer so reset can return to this value
            if (typeof obj.timer !== 'undefined') s.configTimer = secs;
            // ensure any previous timer is cleared, then start a fresh one
            stopTimer(b);
            startTimer(b);
            broadcastState(b);
            console.log(`[update] start board=${b} timerConfig=${s.configTimer}`);
          });
        } else if (obj.action === 'stop') {
          applyTo(boards, (b) => { stopTimer(b); broadcastState(b); console.log(`[update] stop board=${b}`); });
        } else if (obj.action === 'reset') {
          applyTo(boards, (b) => {
            const s = ensureBoardState(b);
            // reset to provided timer if given, otherwise to the configured timer saved at start
            const newTimer = (typeof obj.timer !== 'undefined') ? (Number(obj.timer) || 0) : (typeof s.configTimer !== 'undefined' ? s.configTimer : 0);
            s.timer = newTimer;
            s.timerRunning = false;
            s.score = s.score || 0;
            stopTimer(b);
            broadcastState(b);
            console.log(`[update] reset board=${b} timer=${newTimer}`);
          });
        } else if (obj.action === 'delta') {
          const d = Number(obj.delta) || 0;
          applyTo(boards, (b) => { const s = ensureBoardState(b); s.score = (s.score || 0) + d; broadcastState(b); console.log(`[update] delta board=${b} d=${d} score=${s.score}`); });
        } else if (obj.action === 'set') {
          if (typeof obj.score !== 'undefined') applyTo(boards, (b) => { const s = ensureBoardState(b); s.score = Number(obj.score) || 0; broadcastState(b); console.log(`[update] set score board=${b} score=${s.score}`); });
          if (typeof obj.timer !== 'undefined') applyTo(boards, (b) => { const s = ensureBoardState(b); s.timer = Number(obj.timer) || 0; broadcastState(b); console.log(`[update] set timer board=${b} timer=${s.timer}`); });
        } else if (obj.action === 'broadcast') {
          // set fields to all boards
          const fields = {};
          if (typeof obj.timer !== 'undefined') fields.timer = Number(obj.timer) || 0;
          if (typeof obj.score !== 'undefined') fields.score = Number(obj.score) || 0;
          // apply
          const keys = Array.from(new Set([...boardsState.keys(), ...clients.keys()]));
          if (keys.length === 0) keys.push('1');
          keys.forEach(b => { const s = ensureBoardState(b); Object.assign(s, fields); broadcastState(b); console.log(`[update] broadcast board=${b} fields=${JSON.stringify(fields)}`); });
        }

        // handle score submission
        if (obj.action === 'submit') {
          // expected: { name, score }
          const name = (obj.name || '匿名').toString().slice(0,64);
          applyTo(boards, (b) => {
            const s = ensureBoardState(b);
            s.submissions = s.submissions || [];
            // if score is provided in payload, use it; otherwise record the board's current score
            const sc = (typeof obj.score !== 'undefined') ? (Number(obj.score) || 0) : (s.score || 0);
            s.submissions.push({ name, score: sc, ts: Date.now() });
            // keep only last 100 submissions to avoid unbounded growth
            if (s.submissions.length > 100) s.submissions.splice(0, s.submissions.length - 100);
            broadcastState(b);
            console.log(`[update] submit board=${b} name=${name} score=${sc}`);
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok:true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // GET state for a board
  if (pathname === '/state' && req.method === 'GET') {
    const board = parsed.query.board || '1';
    const s = ensureBoardState(board);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ timer: s.timer, score: s.score, timerRunning: s.timerRunning }));
    return;
  }

  // GET ranking for a board
  if (pathname === '/ranking' && req.method === 'GET') {
    const board = parsed.query.board || '1';
    const s = ensureBoardState(board);
    const ranking = (s.submissions || []).slice().sort((a,b) => b.score - a.score).slice(0,50);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ranking }));
    return;
  }

  // 静的ファイル配信
  let staticPath = pathname === '/' ? '/index.html' : pathname;
  // remove leading slash
  if (staticPath.startsWith('/')) staticPath = staticPath.slice(1);
  serveStatic(req, res, staticPath);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
