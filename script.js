// Agriflow — Dashboard

// Force clear ALL caches immediately
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(regs) {
    regs.forEach(function(r) { r.unregister(); });
  });
}
if ('caches' in window) {
  caches.keys().then(function(keys) {
    keys.forEach(function(k) { caches.delete(k); });
  });
}

let history = [];
let chartRange = 20;
let totalCount = 0;
let chart = null;
let valveStates = [];
