// Service-worker registration. Externalized from the views so it complies
// with the strict CSP (script-src 'self' blocks inline scripts).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(function () {});
}
