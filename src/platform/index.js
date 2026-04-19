// Build-time platform selector. __PLATFORM__ is a Vite define'd constant set
// from the PLATFORM env var in each build script.
//
// The imports are static so the bundler can tree-shake unused adapters — each
// per-platform build only ships its selected adapter.

import web from './web.js';
import youtube from './youtube.js';
import newgrounds from './newgrounds.js';
import wavedash from './stubs/wavedash.js';
import crazygames from './stubs/crazygames.js';
import steam from './stubs/steam.js';
import mobile from './stubs/mobile.js';

const registry = { web, youtube, newgrounds, wavedash, crazygames, steam, mobile };

// __PLATFORM__ is replaced at build time; default to 'web' for dev safety.
// eslint-disable-next-line no-undef
const name = typeof __PLATFORM__ !== 'undefined' ? __PLATFORM__ : 'web';

export const platform = registry[name] || web;
export const platformName = name;
