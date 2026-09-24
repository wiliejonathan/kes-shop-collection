import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET = 'https://collshp.com/kesynaftalia?utm_source=ig&utm_medium=social&utm_content=link_in_bio';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
  locale: 'id-ID',
  timezoneId: 'Asia/Jakarta',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});
const page = await context.newPage();

const gqlTraffic = [];
const allResponses = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('/api/v3/gql/graphql')) {
    gqlTraffic.push({
      type: 'request',
      url,
      method: req.method(),
      headers: req.headers(),
      postData: req.postData()
    });
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/api/v3/gql/graphql')) {
    let body = null;
    try { body = await res.json(); } catch {}
    gqlTraffic.push({
      type: 'response',
      url,
      status: res.status(),
      headers: await res.allHeaders(),
      body
    });
  }
  if (/collshp\.com|shopee|shope\.ee|susercontent/.test(url)) {
    allResponses.push({ url, status: res.status(), contentType: res.headers()['content-type'] || '' });
  }
});

let navError = null;
try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(5000);
} catch (e) {
  navError = String(e);
}

for (const label of ['Terima', 'Setuju', 'Accept', 'OK', 'Nanti', 'Lewati', 'Tutup']) {
  try {
    const loc = page.getByText(label, { exact: true }).first();
    if (await loc.isVisible({ timeout: 500 })) await loc.click({ timeout: 1000 });
  } catch {}
}

let lastHeight = 0;
let stable = 0;
for (let i = 0; i < 100; i++) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(500);
  const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
  if (h2 === lastHeight || h2 === h) stable++; else stable = 0;
  lastHeight = h2;
  if (stable >= 8) break;
}

await page.waitForTimeout(2500);

const dom = await page.evaluate(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const anchors = [...document.querySelectorAll('a[href]')].map((a, idx) => {
    const href = a.href || a.getAttribute('href') || '';
    const img = a.querySelector('img');
    const text = clean(a.innerText || a.textContent);
    return {
      idx,
      href,
      text,
      image: img?.currentSrc || img?.src || '',
      alt: img?.alt || '',
      title: a.getAttribute('title') || ''
    };
  });

  const images = [...document.querySelectorAll('img')].map((img, idx) => {
    let el = img;
    let ancestor = null;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const txt = clean(el.innerText || el.textContent);
      if (txt && txt.length >= 5) { ancestor = el; break; }
    }
    return {
      idx,
      src: img.currentSrc || img.src || '',
      alt: img.alt || '',
      text: clean(ancestor?.innerText || ancestor?.textContent || ''),
      html: (ancestor?.outerHTML || img.outerHTML || '').slice(0, 5000)
    };
  });

  return {
    title: document.title,
    url: location.href,
    bodyText: clean(document.body?.innerText || '').slice(0, 50000),
    anchors,
    images,
    html: document.documentElement.outerHTML
  };
});

await page.screenshot({ path: 'scrape-page.png', fullPage: true }).catch(() => {});

function collectCandidateObjects(root) {
  const out = [];
  const seen = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;
  const shopeeRe = /(shopee\.|shope\.ee|s\.shopee|collshp\.com)/i;
  const imageRe = /(susercontent|cf\.shopee|img\.shopee|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$))/i;
  function walk(v, path='root', depth=0) {
    if (depth > 14 || v == null) return;
    if (Array.isArray(v)) {
      v.forEach((x,i)=>walk(x, path+'['+i+']', depth+1));
      return;
    }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);

    const strings = [];
    for (const [k,val] of Object.entries(v)) {
      if (typeof val === 'string') strings.push([k,val]);
    }
    const urls = strings.flatMap(([k,s]) => (s.match(urlRe) || []).map(u => ({key:k,url:u})));
    const shopeeUrls = urls.filter(x => shopeeRe.test(x.url));
    const imageUrls = urls.filter(x => imageRe.test(x.url));
    const keys = Object.keys(v);
    const looksProductish = shopeeUrls.length || (
      keys.some(k=>/item|product|offer|link|url/i.test(k)) &&
      keys.some(k=>/image|img|picture|title|name/i.test(k))
    );
    if (looksProductish) {
      out.push({ path, value: v, shopeeUrls, imageUrls });
    }
    for (const [k,val] of Object.entries(v)) walk(val, path+'.'+k, depth+1);
  }
  walk(root);
  return out.slice(0, 5000);
}

const responseBodies = gqlTraffic.filter(x => x.type === 'response' && x.body).map(x => x.body);
const candidates = responseBodies.flatMap(collectCandidateObjects);

const affiliateAnchors = dom.anchors.filter(a => /(shopee\.|shope\.ee|s\.shopee)/i.test(a.href));
const uniqueAnchors = [...new Map(affiliateAnchors.map(x => [x.href, x])).values()];

const debug = {
  generatedAt: new Date().toISOString(),
  target: TARGET,
  navError,
  finalUrl: dom.url,
  title: dom.title,
  bodyText: dom.bodyText,
  gqlTraffic,
  candidateCount: candidates.length,
  candidates,
  anchorCount: dom.anchors.length,
  affiliateAnchorCount: uniqueAnchors.length,
  affiliateAnchors: uniqueAnchors,
  responseCount: allResponses.length,
  responses: allResponses.slice(0, 5000)
};

fs.writeFileSync('scrape-debug.json', JSON.stringify(debug, null, 2));
fs.writeFileSync('scrape-page.html', dom.html);

function firstString(obj, keys) {
  for (const key of keys) {
    if (obj && typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
  }
  return '';
}
function deepStrings(obj, predicate, depth=0, seen=new Set()) {
  if (depth > 7 || obj == null) return [];
  if (typeof obj === 'string') return predicate(obj) ? [obj] : [];
  if (typeof obj !== 'object' || seen.has(obj)) return [];
  seen.add(obj);
  const out = [];
  if (Array.isArray(obj)) for (const v of obj) out.push(...deepStrings(v,predicate,depth+1,seen));
  else for (const v of Object.values(obj)) out.push(...deepStrings(v,predicate,depth+1,seen));
  return out;
}

const products = [];
for (const a of uniqueAnchors) {
  products.push({
    name: a.text || a.alt || a.title || 'Produk Shopee',
    image: a.image || '',
    url: a.href,
    source: 'dom'
  });
}
for (const c of candidates) {
  const v = c.value;
  const urls = deepStrings(v, s => /^https?:\/\//i.test(s) && /(shopee\.|shope\.ee|s\.shopee)/i.test(s));
  if (!urls.length) continue;
  const images = deepStrings(v, s => /^https?:\/\//i.test(s) && /(susercontent|cf\.shopee|img\.shopee|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$))/i.test(s));
  const name = firstString(v, ['itemName','productName','title','name','item_name','product_name','displayName']);
  for (const url of urls) {
    products.push({ name: name || 'Produk Shopee', image: images[0] || '', url, source: 'graphql' });
  }
}

const deduped = [];
const seenUrl = new Set();
for (const p of products) {
  const u = p.url?.trim();
  if (!u || seenUrl.has(u)) continue;
  seenUrl.add(u);
  deduped.push(p);
}
fs.writeFileSync('products.json', JSON.stringify({
  source: TARGET,
  syncedAt: new Date().toISOString(),
  count: deduped.length,
  products: deduped
}, null, 2));

console.log(JSON.stringify({
  finalUrl: dom.url,
  title: dom.title,
  gqlEvents: gqlTraffic.length,
  candidates: candidates.length,
  anchors: dom.anchors.length,
  affiliateAnchors: uniqueAnchors.length,
  products: deduped.length
}, null, 2));

await browser.close();
