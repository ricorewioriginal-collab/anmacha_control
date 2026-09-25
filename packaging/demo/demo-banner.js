// Nur in der Demo enthalten (siehe Dockerfile.demo) - blendet einen deutlichen Hinweis ein, dass es
// sich um eine Testinstanz handelt, die sich automatisch zurücksetzt.
(() => {
  const bar = document.createElement('div');
  bar.textContent = '🧪 Testinstanz – wird automatisch alle 10 Minuten komplett zurückgesetzt (alle Daten weg). Keine echte 24/7-Sendung möglich. Bitte nichts Echtes hier ablegen.';
  Object.assign(bar.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '99999',
    background: '#f5c04a', color: '#1a1200', font: '600 13px/1.4 system-ui, sans-serif',
    padding: '8px 16px', textAlign: 'center', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.body.prepend(bar);
    document.body.style.paddingTop = `${bar.offsetHeight}px`;
  });
})();
