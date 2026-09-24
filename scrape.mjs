import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET = 'https://collshp.com/kesynaftalia?utm_source=ig&utm_medium=social&utm_content=link_in_bio';
const URL_SUFFIX = 'kesynaftalia';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
  locale: 'id-ID',
  timezoneId: 'Asia/Jakarta',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});
const page = await context.newPage();

let navError = null;
try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);
} catch (e) {
  navError = String(e);
}

const syncResult = await page.evaluate(async ({ urlSuffix }) => {
  const endpoint = 'https://collshp.com/api/v3/gql/graphql';

  const baseQuery = `query getBaseInfoAndLinks($urlSuffix: String!, $pageSize: String, $pageNum: String, $groupId: String, $linkNameKeyword: String) {
    landingPageBaseInfo(urlSuffix: $urlSuffix) {
      name
      headPortrait
      description
      region
      affiliateId
      shopLink
      background
      groupList {
        groupId
        groupName
        groupType
      }
      topFiveExternalLinkImages
    }
    landingPageLinkList(
      urlSuffix: $urlSuffix
      pageSize: $pageSize
      pageNum: $pageNum
      groupId: $groupId
      linkNameKeyword: $linkNameKeyword
    ) {
      totalCount
      linkList {
        linkId
        link
        linkName
        image
        linkType
        groupIds
      }
    }
  }`;

  const listQuery = `query getLinkLists($urlSuffix: String!, $pageSize: String, $pageNum: String, $groupId: String, $linkNameKeyword: String) {
    landingPageLinkList(
      urlSuffix: $urlSuffix
      pageSize: $pageSize
      pageNum: $pageNum
      groupId: $groupId
      linkNameKeyword: $linkNameKeyword
    ) {
      totalCount
      linkList {
        linkId
        link
        linkName
        image
        linkType
        groupIds
      }
    }
  }`;

  async function gql(operationName, query, variables) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify({ operationName, query, variables })
    });
    if (!res.ok) throw new Error('GraphQL HTTP ' + res.status);
    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }

  const pageSize = 40;
  const first = await gql('getBaseInfoAndLinks', baseQuery, {
    urlSuffix,
    pageSize: String(pageSize),
    pageNum: '1'
  });

  const profile = first?.landingPageBaseInfo || null;
  const firstList = first?.landingPageLinkList || { totalCount: 0, linkList: [] };
  const totalCount = Number(firstList.totalCount || 0);
  const all = [...(firstList.linkList || [])];

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    const data = await gql('getLinkLists', listQuery, {
      urlSuffix,
      pageSize: String(pageSize),
      pageNum: String(pageNum)
    });
    const list = data?.landingPageLinkList?.linkList || [];
    all.push(...list);
  }

  const deduped = [];
  const seen = new Set();
  for (const item of all) {
    const key = item?.linkId || item?.link;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return { profile, totalCount, products: deduped };
}, { urlSuffix: URL_SUFFIX });

const normalized = (syncResult.products || []).map((item, index) => ({
  order: index + 1,
  linkId: item.linkId || '',
  name: item.linkName || 'Produk Shopee',
  image: item.image || '',
  url: item.link || '',
  linkType: item.linkType || '',
  groupIds: item.groupIds || []
}));

const output = {
  source: TARGET,
  syncedAt: new Date().toISOString(),
  expectedCount: Number(syncResult.totalCount || 0),
  count: normalized.length,
  profile: syncResult.profile || null,
  products: normalized
};

fs.writeFileSync('products.json', JSON.stringify(output, null, 2));
fs.writeFileSync('scrape-debug.json', JSON.stringify({
  generatedAt: output.syncedAt,
  target: TARGET,
  navError,
  finalUrl: page.url(),
  title: await page.title(),
  expectedCount: output.expectedCount,
  count: output.count,
  first: normalized.slice(0, 3),
  last: normalized.slice(-3)
}, null, 2));

console.log(JSON.stringify({
  finalUrl: page.url(),
  title: await page.title(),
  expectedCount: output.expectedCount,
  products: output.count,
  groups: output.profile?.groupList?.length || 0
}, null, 2));

if (output.expectedCount && output.count !== output.expectedCount) {
  throw new Error(`Incomplete scrape: expected ${output.expectedCount}, got ${output.count}`);
}

let corsProbe = { ok: false };
try {
  const probePage = await context.newPage();
  await probePage.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  corsProbe = await probePage.evaluate(async () => {
    const query = 'query getLinkLists($urlSuffix: String!, $pageSize: String, $pageNum: String, $groupId: String, $linkNameKeyword: String) { landingPageLinkList(urlSuffix: $urlSuffix, pageSize: $pageSize, pageNum: $pageNum, groupId: $groupId, linkNameKeyword: $linkNameKeyword) { totalCount linkList { linkId link linkName image linkType groupIds } } }';
    try {
      const r = await fetch('https://collshp.com/api/v3/gql/graphql', {
        method:'POST', mode:'cors',
        headers:{'accept':'application/json, text/plain, */*','content-type':'application/json;charset=UTF-8'},
        body: JSON.stringify({operationName:'getLinkLists',query,variables:{urlSuffix:'kesynaftalia',pageSize:'1',pageNum:'1'}})
      });
      const j = await r.json();
      return {ok:r.ok,status:r.status,totalCount:j?.data?.landingPageLinkList?.totalCount||0};
    } catch (e) { return {ok:false,error:String(e)}; }
  });
  await probePage.close();
} catch (e) { corsProbe = {ok:false,error:String(e)}; }
const dbg = JSON.parse(fs.readFileSync('scrape-debug.json','utf8'));
dbg.corsProbe = corsProbe;
fs.writeFileSync('scrape-debug.json', JSON.stringify(dbg,null,2));
console.log('CORS probe', corsProbe);
let siteQa = { ok: false, viewports: [] };
try {
  const testPage = await context.newPage();
  const html = fs.readFileSync('index.html','utf8');
  await testPage.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await testPage.waitForFunction(() => Number(document.getElementById('heroCount')?.textContent || 0) >= 372, null, { timeout: 20000 });
  const sizes = [{w:320,h:800},{w:600,h:1000},{w:900,h:1100},{w:1440,h:1100}];
  for (const v of sizes) {
    await testPage.setViewportSize({width:v.w,height:v.h});
    await testPage.waitForTimeout(250);
    const m = await testPage.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cards: document.querySelectorAll('#grid .card').length,
      heroCount: document.getElementById('heroCount')?.textContent,
      visibleCount: document.getElementById('visibleCount')?.textContent,
      sync: document.getElementById('syncStatus')?.textContent
    }));
    siteQa.viewports.push({...m,noHorizontalOverflow:m.scrollWidth <= m.width + 1});
  }
  siteQa.ok = siteQa.viewports.every(v => v.cards > 0 && v.heroCount === '372' && v.noHorizontalOverflow);
  await testPage.close();
} catch (e) { siteQa = {ok:false,error:String(e),viewports:siteQa.viewports||[]}; }
const dbg2 = JSON.parse(fs.readFileSync('scrape-debug.json','utf8'));
dbg2.siteQa = siteQa;
fs.writeFileSync('scrape-debug.json', JSON.stringify(dbg2,null,2));
console.log('SITE QA', siteQa);
await browser.close();
