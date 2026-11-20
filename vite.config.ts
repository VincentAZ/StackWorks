import { defineConfig } from 'vite';
import { COMPONENT_MAP, COMPONENT_ORDER, FOUNDER_COPY } from './src/content/components';

function htmlText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export default defineConfig({
  base: './',
  plugins: [{
    name: 'component-guide',
    transformIndexHtml(html) {
      // Keep the guide readable even when a browser cannot load the exhibit bundle.
      const entries = COMPONENT_ORDER.map((id) => {
        const name = htmlText(COMPONENT_MAP[id].name);
        const description = htmlText(FOUNDER_COPY[id].description);
        return `<details id="guide-${id}"><summary>${name}</summary><p>${description}</p></details>`;
      });
      return html.replace('<!-- component-guide-entries -->', () => entries.join('\n'));
    },
  }],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
