// Derleme zamanı sabitleri — scripts/build.mjs `define` ile değiştiriyor.

/**
 * `true` yalnız `npm run build:dev`'de. Yayın derlemesinde `false` ve
 * `if (__DEV__) { … }` blokları pakete hiç girmiyor (build.mjs dist/'i
 * tarayıp doğruluyor).
 */
declare const __DEV__: boolean;
