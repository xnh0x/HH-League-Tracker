// ==UserScript==
// @name         HH League Tracker GitHub Config
// @version      1.0
// @description  Provide GitHub repo for the tracker script
// @author       xnh0x
// @match        https://*.hentaiheroes.com/leagues.html*
// @match        https://nutaku.haremheroes.com/leagues.html*
// @match        https://*.comixharem.com/leagues.html*
// @match        https://*.pornstarharem.com/leagues.html*
// @match        https://*.gayharem.com/leagues.html*
// @match        https://*.gaypornstarharem.com/leagues.html*
// @match        https://*.transpornstarharem.com/leagues.html*
// @match        https://*.hornyheroes.com/leagues.html*
// @run-at       document-body
// @namespace    https://github.com/xnh0x/HH-League-Tracker
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hentaiheroes.com
// @grant        none
// ==/UserScript==

(function () {
    window.LeagueTrackerGitHubConfig = {
        owner: 'REPO_OWNER',
        repo: 'REPO_NAME',
        token: 'ACCESS_TOKEN',
    };
})()