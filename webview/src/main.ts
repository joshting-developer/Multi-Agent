import { createApp } from 'vue';
import App from './App.vue';
import SettingsApp from './SettingsApp.vue';
import './styles.css';
createApp(document.getElementById('app')?.dataset.surface === 'settings' ? SettingsApp : App).mount('#app');
