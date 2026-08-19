import { mount } from 'svelte';
import App from './App.svelte';
import '../request/styles.css';
import './console.css';

mount(App, { target: document.getElementById('app')! });
