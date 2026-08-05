#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_PATH = process.env.VISUAL_REVIEW_CONFIG ?? 'config/representative-visual-review.json';
const BASE_URL = (process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const OUTPUT_ROOT = process.env.VISUAL_REVIEW_OUTPUT ?? 'artifacts/representative-visual-review';

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const devices = config.devices ?? {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true }
};

function safeName(value) {
  return String(value).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'page';
}

async function measure(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const supportPattern = /(support|donat(?:e|ion)|contribut|fund|back this|help keep|tip|wallet)/i;
    const supportLinks = [...document.querySelectorAll('a, button')]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = [
          element.textContent ?? '',
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? ''
        ].join(' ').replace(/\s+/g, ' ').trim();
        const href = element instanceof HTMLAnchorElement ? element.href : '';
        return {
          text,
          href,
          location: element.closest('header') ? 'header'
            : element.closest('footer') ? 'footer'
            : element.closest('main') ? 'main'
            : 'other',
          top: Math.round(rect.top + window.scrollY),
          in_initial_viewport: rect.bottom > 0 && rect.top < window.innerHeight,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
      .filter((item) => supportPattern.test(`${item.text} ${item.href}`));

    const root = document.documentElement;
    const brokenImages = [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src || 'missing-src');

    return {
      title: document.title,
      h1_count: document.querySelectorAll('h1').length,
      main_count: document.querySelectorAll('main').length,
      body_height: Math.round(document.body.getBoundingClientRect().height),
      viewport_width: root.clientWidth,
      horizontal_overflow_px: Math.max(0, root.scrollWidth - root.clientWidth),
      broken_images: brokenImages,
      support_links: supportLinks,
      support_link_count: supportLinks.length,
      support_links_in_initial_viewport: supportLinks.filter((item) => item.in_initial_viewport).length
    };
  });
}

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const records = [];
const failures = [];

for (const [deviceName, device] of Object.entries(devices)) {
  const deviceDir = path.join(OUTPUT_ROOT, deviceName);
  await mkdir(deviceDir, { recursive: true });

  for (const pageSpec of config.pages) {
    const id = `${safeName(pageSpec.id)}-${deviceName}`;
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: 1,
      isMobile: Boolean(device.isMobile),
      hasTouch: Boolean(device.hasTouch),
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    const url = `${BASE_URL}${pageSpec.route}`;

    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      if (!response || !response.ok()) throw new Error(`HTTP ${response?.status() ?? 'no response'}`);
      await page.evaluate(() => document.fonts?.ready);

      const metrics = await measure(page);
      const viewportFile = path.join(deviceDir, `${id}.viewport.png`);
      const fullFile = path.join(deviceDir, `${id}.full.png`);
      await page.screenshot({ path: viewportFile, fullPage: false });
      await page.screenshot({ path: fullFile, fullPage: true });

      const viewportBytes = (await stat(viewportFile)).size;
      const fullBytes = (await stat(fullFile)).size;
      const issues = [];
      if (metrics.h1_count !== 1) issues.push(`expected one h1, found ${metrics.h1_count}`);
      if (metrics.main_count !== 1) issues.push(`expected one main, found ${metrics.main_count}`);
      if (metrics.horizontal_overflow_px > 2) issues.push(`horizontal overflow ${metrics.horizontal_overflow_px}px`);
      if (metrics.broken_images.length) issues.push(`${metrics.broken_images.length} broken image(s)`);

      records.push({
        id,
        page_id: pageSpec.id,
        route: pageSpec.route,
        device: deviceName,
        viewport: { width: device.width, height: device.height },
        viewport_file: viewportFile,
        full_file: fullFile,
        viewport_bytes: viewportBytes,
        full_bytes: fullBytes,
        metrics,
        issues
      });
      if (issues.length) failures.push({ id, route: pageSpec.route, device: deviceName, issues });
      console.log(`[${deviceName}] captured ${pageSpec.route}`);
    } catch (error) {
      failures.push({
        id,
        route: pageSpec.route,
        device: deviceName,
        issues: [error instanceof Error ? error.message : String(error)]
      });
      console.error(`[${deviceName}] failed ${pageSpec.route}: ${error}`);
    } finally {
      await context.close();
    }
  }
}

await browser.close();

const expectedStateCount = config.pages.length * Object.keys(devices).length;
const manifest = {
  schema_version: '1.0',
  site: config.site,
  generated_at: new Date().toISOString(),
  base_url: BASE_URL,
  expected_state_count: expectedStateCount,
  captured_state_count: records.length,
  screenshot_count: records.length * 2,
  failure_count: failures.length,
  records,
  failures,
  status: failures.length === 0 && records.length === expectedStateCount ? 'pass' : 'fail'
};
await writeFile(path.join(OUTPUT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const cards = records.map((record) => `
<article>
  <h2>${record.page_id} · ${record.device}</h2>
  <p><code>${record.route}</code></p>
  <img src="${path.relative(OUTPUT_ROOT, record.viewport_file)}" alt="${record.page_id} ${record.device} initial viewport">
  <img src="${path.relative(OUTPUT_ROOT, record.full_file)}" alt="${record.page_id} ${record.device} full page">
  <p>Support-like links: ${record.metrics.support_link_count}; in initial viewport: ${record.metrics.support_links_in_initial_viewport}</p>
</article>`).join('\n');

const indexHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${config.site} representative visual review</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#f5f5f5;color:#111}
main{display:grid;gap:24px}
article{background:#fff;border:1px solid #ccc;padding:16px}
img{display:block;max-width:100%;height:auto;border:1px solid #ddd;margin-top:12px}
code{overflow-wrap:anywhere}
</style>
<main><h1>${config.site} representative visual review</h1>${cards}</main></html>`;
await writeFile(path.join(OUTPUT_ROOT, 'index.html'), indexHtml);

console.log(JSON.stringify({
  site: config.site,
  expected_state_count: expectedStateCount,
  captured_state_count: records.length,
  failure_count: failures.length
}, null, 2));

if (manifest.status !== 'pass') process.exitCode = 1;
