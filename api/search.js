// 다이소몰 상품 검색을 대신 호출해주는 서버리스 함수 (Vercel Serverless Function)
// 브라우저에서 daisomall.co.kr 을 직접 호출하면 막힐 수 있어서, 이 함수가 대신 요청하고
// 결과만 우리 프론트엔드에 돌려줍니다. 응답은 잠깐(10분) 메모리에 캐시해서
// 같은 검색어를 짧은 시간에 반복 요청하지 않도록 합니다.

const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분 캐시
const MIN_INTERVAL_MS = 400; // 다이소몰 서버로 나가는 요청 사이 최소 간격

let lastUpstreamCall = 0;

function cdnImage(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `https://cdn.daisomall.co.kr${path}`;
}

async function fetchDaisoSearch(term) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastUpstreamCall));
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastUpstreamCall = Date.now();

  const params = new URLSearchParams({
    searchTerm: term,
    searchQuery: '',
    pageNum: '1',
    brndCd: '',
    cntPerPage: '20',
    userId: '',
    newPdYn: '',
    massOrPsblYn: '',
    pkupOrPsblYn: '',
    fdrmOrPsblYn: '',
    quickOrPsblYn: '',
    searchSort: '',
    isCategory: '1',
    mallId: 'MALL_MAIN',
  });

  const url = `https://www.daisomall.co.kr/ssn/search/SearchGoods?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; DaisoCartApp/1.0; personal use)',
    },
  });

  if (!res.ok) {
    throw new Error(`upstream_status_${res.status}`);
  }

  const data = await res.json();
  // 다이소몰 응답의 resultSet.result 는 배열인데, 상품 목록(resultDocuments)이
  // 몇 번째 원소에 들어있는지 고정되어 있지 않아서 찾아서 사용합니다.
  const resultArr = Array.isArray(data?.resultSet?.result) ? data.resultSet.result : [];
  const docs = resultArr.find((r) => Array.isArray(r?.resultDocuments))?.resultDocuments;

  if (!Array.isArray(docs)) {
    // 다이소몰 쪽 응답 형식이 바뀐 경우: 에러로 처리해서 프론트가 수동입력 폴백을 쓰게 함
    throw new Error('unexpected_response_shape');
  }

  return docs
    .map((d) => ({
      pdNo: d.pdNo,
      name: d.exhPdNm || d.pdNm || '',
      price: Number(d.pdPrc) || 0,
      image: cdnImage(d.pdImgUrl),
      soldOut: d.soldOutYn === 'Y',
    }))
    .filter((item) => item.pdNo && item.name);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const term = (req.query.q || '').toString().trim();

  if (!term) {
    res.status(400).json({ ok: false, error: 'missing_query', items: [] });
    return;
  }
  if (term.length > 40) {
    res.status(400).json({ ok: false, error: 'query_too_long', items: [] });
    return;
  }

  const key = term.toLowerCase();
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.status(200).json({ ok: true, items: cached.items, cached: true });
    return;
  }

  try {
    const items = await fetchDaisoSearch(term);
    CACHE.set(key, { items, at: Date.now() });
    res.status(200).json({ ok: true, items, cached: false });
  } catch (err) {
    // 업스트림이 죽어도 우리 앱은 죽지 않고, 프론트가 수동입력으로 전환하도록 ok:false만 내려줌
    res.status(200).json({ ok: false, error: 'upstream_unavailable', items: [] });
  }
};
