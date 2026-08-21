import { mount } from 'svelte';
import App from './App.svelte';
import '../request/styles.css';
import './collection.css';

mount(App, { target: document.getElementById('app')! });
