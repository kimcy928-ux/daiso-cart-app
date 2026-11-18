// 친구와 같이 쓰는 공유 장바구니 저장/조회 (Vercel KV 사용)
// 같은 "방 코드"로 저장(POST)하고 불러오면(GET), 두 사람 모두 같은 목록을 보게 됩니다.
// Vercel 대시보드에서 이 프로젝트에 Storage(KV)를 하나 연결해야 동작합니다 (README 참고).

const { kv } = require('@vercel/kv');

const ROOM_RE = /^[A-Za-z0-9]{4,12}$/;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30일간 아무도 안 건드리면 자동 삭제

function cartKey(room) {
  return `daiso-cart:${room.toUpperCase()}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const room = (req.query.room || '').toString().trim();
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ ok: false, error: 'invalid_room' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const items = await kv.get(cartKey(room));
      res.status(200).json({ ok: true, items: Array.isArray(items) ? items : [] });
    } catch (err) {
      res.status(200).json({ ok: false, error: 'storage_unavailable', items: [] });
    }
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const items = body?.items;
    if (!Array.isArray(items)) {
      res.status(400).json({ ok: false, error: 'invalid_items' });
      return;
    }
    if (items.length > 300) {
      res.status(400).json({ ok: false, error: 'too_many_items' });
      return;
    }
    try {
      await kv.set(cartKey(room), items, { ex: TTL_SECONDS });
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(200).json({ ok: false, error: 'storage_unavailable' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'method_not_allowed' });
};
