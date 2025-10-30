// 共通ユーティリティ
function getQueryParam(name) {
  const params = new URLSearchParams(location.search);
  return params.get(name);
}

function formatTime(seconds) {
  if (seconds == null) return '00:00';
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function postJson(url, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!res.ok) throw new Error('ネットワークエラー: ' + res.status);
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('ネットワークエラー: ' + res.status);
  return res.json();
}

// エクスポート（ブラウザで直接使う）
window.getQueryParam = getQueryParam;
window.formatTime = formatTime;
window.postJson = postJson;
window.getJson = getJson;
