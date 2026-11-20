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
    if (!webgl) await page.setViewport({ width: 5120, height: 1440, deviceScaleFactor: 1 });
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
      const dimensions = await canvas.evaluate((el) => [el.width, el.height]);
      assert.deepEqual(dimensions, [5120, 1440], 'ultrawide output uses display pixels');
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
    await page.click('.topbar [title="Settings"]');
    await page.locator('::-p-aria(High[role="button"])').click();
    await page.waitForFunction(() => {
      const { store, scene } = window.__stackworks;
      if (store.get().quality !== 'high') return false;
      const { renderer, composer } = scene;
      if (composer) return composer.readBuffer.width === Math.floor(renderer.domElement.width * 1.5);
      return renderer.viewport.scale === 3 && renderer.domElement.width === 5120;
    });
    await page.locator('::-p-aria(Auto[role="button"])').click();
    await page.waitForFunction(() => {
      const { store, scene } = window.__stackworks;
      return store.get().quality === 'auto' && (scene.composer
        ? scene.composer.readBuffer.width === scene.renderer.domElement.width
        : scene.renderer.sampleScale <= 2);
    });
    await page.click('.modal__head [title="Close"]');
    await page.waitForSelector('.modal-backdrop', { hidden: true });
    await page.click('.topbar__search');
    const input = await page.waitForSelector('[role="dialog"] input', { visible: true });
    await input.type('backend');
    await input.press('Enter');
    await page.waitForFunction(() => window.__stackworks.store.get().selected === 'backend');
    await page.waitForSelector('.insp__body', { visible: true });

    if (!webgl) {
      await page.setViewport({ width: 790, height: 1116, deviceScaleFactor: 2 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.gl-canvas');
        return canvas.width === 1580 && canvas.height === 2232;
      });
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
