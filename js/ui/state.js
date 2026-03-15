// ═══════════════════════════════════════════════════════════════════
// Reactive State Management (Pub-Sub)
// ═══════════════════════════════════════════════════════════════════

const data = {};
const listeners = {};

export const state = {
  get(key) {
    return data[key];
  },

  set(key, value) {
    const old = data[key];
    data[key] = value;
    if (listeners[key]) {
      for (const fn of listeners[key]) {
        try { fn(value, old); } catch (e) { console.error(`State listener error [${key}]:`, e); }
      }
    }
  },

  on(key, fn) {
    if (!listeners[key]) listeners[key] = [];
    listeners[key].push(fn);
    // Call immediately with current value if it exists
    if (key in data) {
      try { fn(data[key], undefined); } catch (e) { console.error(`State listener init error [${key}]:`, e); }
    }
    return () => {
      listeners[key] = listeners[key].filter(f => f !== fn);
    };
  },
};
