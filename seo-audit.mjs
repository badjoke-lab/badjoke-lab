import fs from 'node:fs';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const sitemap = fs.readFileSync(new URL('./sitemap.xml', import.meta.url), 'utf8');
const required = [
  '<link rel="canonical" href="https://badjoke-lab.com/"',
  'property="og:image"',
  'name="twitter:title"',
  'name="twitter:description"',
  'name="twitter:image"',
  '"@type": "WebSite"',
  '"@type": "Organization"',
  'https://hei.badjoke-lab.com/',
  'https://www.stableorgone.com/',
  'https://cya.badjoke-lab.com/',
  'https://bir.badjoke-lab.com/',
];
for (const token of required) {
  if (!html.includes(token)) throw new Error(`Missing SEO token: ${token}`);
}
if (!sitemap.includes('<lastmod>2026-08-05</lastmod>')) throw new Error('Hub sitemap lastmod is stale.');
console.log('Hub SEO audit: pass');
