import { mount } from 'svelte';
import App from './App.svelte';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('SW registration failed', e));
}

export default mount(App, { target: document.getElementById('app')! });
