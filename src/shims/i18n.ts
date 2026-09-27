/**
 * Shim écrit à la main pour vellum-engine (pas un miroir automatique) :
 * mêmes valeurs que le type `Lang` de vellum-pdf/src/lib/i18n.ts, sans le
 * reste du module (traduction d'URL, slugs par langue) qui n'a pas de sens
 * hors du site vellumpdf.ch.
 */
export type Lang = 'fr' | 'de' | 'it' | 'en' | 'es' | 'pt'
