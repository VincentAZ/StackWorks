// Run against a Vite preview or a deployed exhibit using the installed Chrome.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:4173/';
for (const webgl of [true, false]) {
  const browser = await puppeteer.launch({
    channel: 'chrome',
    args: ['--no-sandbox', ...(webgl ? [] : ['--disable-webgl'])],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    if (webgl) {
      await page.waitForSelector('.onboard__actions', { visible: true });
      await page.click('.onboard__actions .btn:nth-child(2)');
      await page.waitForSelector('.modal-backdrop', { hidden: true });
      await page.click('.topbar__search');
      await page.waitForSelector('[role="dialog"] input', { visible: true });
      assert.equal(await page.$('#component-guide'), null);
      assert.ok(await page.$('.gl-canvas'));
    } else {
      await page.waitForFunction(() => document.querySelector('#exhibit-status')?.textContent.includes('WebGL 2'));
      assert.equal(await page.$$eval('#component-guide details', (entries) => entries.length), 17);
      await page.click('#guide-database summary');
      await page.waitForSelector('#guide-database[open] p', { visible: true });
      await page.goto(new URL('?focus=backend', url).href);
      await page.waitForSelector('#guide-backend[open] p', { visible: true });
    }
    assert.deepEqual(errors, []);
    console.log(webgl ? '3D exhibit and search passed' : 'Component guide and focused link passed with WebGL disabled');
  } finally {
    await browser.close();
  }
}
