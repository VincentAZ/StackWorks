const guide = document.getElementById('component-guide')!;
const exhibitStatus = document.getElementById('exhibit-status')!;
exhibitStatus.textContent = 'Opening the 3D exhibit…';

import('./main').then(() => {
  document.getElementById('app')!.removeAttribute('inert');
  guide.remove();
}, (error: unknown) => {
  console.error('StackWorks could not start the 3D exhibit.', error);
  exhibitStatus.textContent = error instanceof DOMException && error.name === 'NotSupportedError'
    ? 'The 3D exhibit needs WebGL 2. You can explore the components below or enable graphics acceleration in your browser and reload.'
    : 'The 3D exhibit could not open. You can explore the components below or reload to try again.';

  const focus = new URLSearchParams(location.search).get('focus');
  const entry = document.getElementById(`guide-${focus}`);
  if (entry instanceof HTMLDetailsElement) {
    entry.open = true;
    entry.scrollIntoView({ block: 'nearest' });
  }
});
