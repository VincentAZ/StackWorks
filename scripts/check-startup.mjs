// Run against a Vite preview or a deployed exhibit using the installed Chrome.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:4173/';
for (const webgl of [true, false]) {
  const browser = await puppeteer.launch({
    channel: 'chrome',
    args: ['--no-sandbox', ...(webgl ? [] : ['--disable-webgl', '--disable-gpu'])],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('.onboard__actions', { visible: true });
    await page.click('.onboard__actions .btn:nth-child(2)');
    await page.waitForSelector('.modal-backdrop', { hidden: true });
    assert.equal(await page.$('#component-guide'), null);

    const canvas = await page.waitForSelector('.gl-canvas', { visible: true });
    if (webgl) {
      assert.ok(await canvas.evaluate((el) => !!el.getContext('webgl2')));
    } else {
      // Read the actual canvas, so an empty scene with working controls fails.
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.gl-canvas');
        const context = canvas.getContext('2d');
        if (!context) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const colors = new Set();
        for (let i = 0; i < data.length; i += 64) {
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        return colors.size > 32;
      });
    }
    await page.click('.topbar__search');
    const input = await page.waitForSelector('[role="dialog"] input', { visible: true });
    await input.type('backend');
    await input.press('Enter');
    await page.waitForFunction(() => window.__stackworks.store.get().selected === 'backend');
    await page.waitForSelector('.insp__body', { visible: true });

    if (!webgl) {
      await page.setJavaScriptEnabled(false);
      await page.reload();
      assert.equal(await page.$$eval('#component-guide details', (entries) => entries.length), 17);
      await page.click('#guide-database summary');
      await page.waitForSelector('#guide-database[open] p', { visible: true });
    }
    assert.deepEqual(errors, []);
    console.log(webgl ? 'WebGL exhibit and inspector passed' : 'Software-rendered exhibit, inspector and HTML guide passed');
  } finally {
    await browser.close();
  }
}
