// Preload for the end-to-end request test: installs recording-provider-hooks.mjs.
import { register } from 'node:module';

register(new URL('./recording-provider-hooks.mjs', import.meta.url));
