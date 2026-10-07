// Preload for the isolation test: installs resolve-log-hooks.mjs.
import { register } from 'node:module';

register(new URL('./resolve-log-hooks.mjs', import.meta.url));
