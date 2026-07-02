import type { ThemeRegistration } from 'shiki';

/**
 * An Old Hope dark theme for Shiki, built from the palette:
 * background #1c1d21, foreground #cbcdd2
 */
export const anOldHopeShiki: ThemeRegistration = {
  name: 'an-old-hope',
  type: 'dark',
  colors: {
    'editor.background': '#1c1d21',
    'editor.foreground': '#cbcdd2',
  },
  settings: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#686b78', fontStyle: 'italic' },
    },
    {
      scope: ['string', 'constant.other.symbol'],
      settings: { foreground: '#78bd65' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character'],
      settings: { foreground: '#ef7c2a' },
    },
    {
      scope: ['keyword', 'storage.type', 'storage.modifier'],
      settings: { foreground: '#eb3d54' },
    },
    {
      scope: ['entity.name.function', 'support.function'],
      settings: { foreground: '#4fb4d8' },
    },
    {
      scope: ['variable', 'variable.parameter', 'meta.definition.variable'],
      settings: { foreground: '#cbcdd2' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
      settings: { foreground: '#e5cd52' },
    },
    {
      scope: ['entity.name.tag'],
      settings: { foreground: '#eb3d54' },
    },
    {
      scope: ['entity.other.attribute-name'],
      settings: { foreground: '#e5cd52' },
    },
  ],
};
