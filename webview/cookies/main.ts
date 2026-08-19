import { mount } from 'svelte';
import App from './App.svelte';
import '../request/styles.css';
import './cookies.css';

mount(App, { target: document.getElementById('app')! });
