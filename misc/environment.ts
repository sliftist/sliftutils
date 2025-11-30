/// <reference path="../node_modules/@types/chrome/index.d.ts" />
export function isInChromeExtension() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
}
export function isInElectron() {
    return typeof process !== "undefined" && process.versions && process.versions.electron;
}
let isInBuildFlag = false;
export function triggerIsInBuild() {
    isInBuildFlag = true;
}
export function isInBuild() {
    return isInBuildFlag;
}