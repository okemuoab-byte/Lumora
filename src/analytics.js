import posthog from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

export function initAnalytics() {
  if (!KEY) return;
  posthog.init(KEY, {
    api_host: HOST,
    person_profiles: 'always',
    capture_pageview: true,
    autocapture: false,
  });
}

export function identify(email, props = {}) {
  if (!KEY) return;
  posthog.identify(email, props);
}

export function track(event, props = {}) {
  if (!KEY) return;
  posthog.capture(event, props);
}

export function reset() {
  if (!KEY) return;
  posthog.reset();
}
